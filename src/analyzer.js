import { canonicalRuleIds, compareRules } from "./ordering.js";
import { ACTION_SEVERITY } from "./schema.js";

function resultName(result) {
  return String(result);
}

export class DlpAnalyzer {
  // options (all optional; the defaults keep the original behaviour):
  //   queryTimeoutMs     per-query solver timeout; a timed-out query returns
  //                      UNKNOWN (reason "timeout") and is counted as such.
  //   onProgress         callback receiving progress events (stage start/end
  //                      and, between queries, at most every progressIntervalMs).
  //                      No event can be emitted while a single solver query
  //                      is running, so heartbeats are not guaranteed during
  //                      a long query.
  //   progressIntervalMs throttle for between-query progress events (5000).
  constructor(Context, policy, contextName = `policylint_${Date.now()}`, options = {}) {
    this.policy = policy;
    this.queryTimeoutMs = options.queryTimeoutMs ?? null;
    this.onProgress = options.onProgress ?? null;
    this.progressIntervalMs = options.progressIntervalMs ?? 5000;
    this.stage = null;
    this.analysisStartedAt = null;
    this.lastProgressAt = 0;
    this.z = new Context(contextName);
    this.variables = {};
    this.indexes = {};
    this.domainConstraints = [];

    for (const [attribute, values] of Object.entries(policy.domains)) {
      const variable = this.z.Int.const(attribute);
      this.variables[attribute] = variable;
      this.indexes[attribute] = new Map(values.map((value, index) => [value, index]));
      this.domainConstraints.push(variable.ge(0), variable.lt(values.length));
    }

    this.variables.size_mb = this.z.Int.const("size_mb");
    const [sizeMin, sizeMax] = policy.numeric_limits.size_mb;
    this.domainConstraints.push(this.variables.size_mb.ge(sizeMin), this.variables.size_mb.le(sizeMax));
    this.ruleFormulaCache = new Map();
    // Solver factory; replaceable by a test double (see test/query-status.test.js).
    // It receives the check name and subject of the query being built.
    this.createSolver = (check, subject) => new this.z.Solver();
    this.queryStats = emptyQueryStats();
  }

  bool(value) {
    return this.z.Bool.val(Boolean(value));
  }

  and(expressions) {
    if (expressions.length === 0) return this.bool(true);
    if (expressions.length === 1) return expressions[0];
    return this.z.And(...expressions);
  }

  or(expressions) {
    if (expressions.length === 0) return this.bool(false);
    if (expressions.length === 1) return expressions[0];
    return this.z.Or(...expressions);
  }

  clauseFormula(clause) {
    const formulas = [];
    for (const [attribute, constraint] of Object.entries(clause)) {
      const variable = this.variables[attribute];
      if (attribute === "size_mb") {
        if (typeof constraint === "number") {
          formulas.push(variable.eq(constraint));
        } else {
          if (constraint.min !== undefined) formulas.push(variable.ge(constraint.min));
          if (constraint.max !== undefined) formulas.push(variable.le(constraint.max));
        }
        continue;
      }
      if (constraint === "*" || constraint === undefined) continue;
      const requested = Array.isArray(constraint) ? constraint : [constraint];
      formulas.push(this.or(requested.map(value => variable.eq(this.indexes[attribute].get(value)))));
    }
    return this.and(formulas);
  }

  ruleBaseFormula(rule) {
    return rule.enabled ? this.clauseFormula(rule.conditions) : this.bool(false);
  }

  ruleFormula(rule) {
    if (this.ruleFormulaCache.has(rule.id)) return this.ruleFormulaCache.get(rule.id);
    const base = this.ruleBaseFormula(rule);
    const excluded = this.or(rule.exceptions.map(exception => this.clauseFormula(exception)));
    const formula = this.and([base, this.z.Not(excluded)]);
    this.ruleFormulaCache.set(rule.id, formula);
    return formula;
  }

  decisionExpression(rules = this.policy.rules, semantics = this.policy.semantics) {
    const active = rules
      .filter(rule => rule.enabled)
      .sort(compareRules);
    const defaultDecision = this.z.Int.val(ACTION_SEVERITY[this.policy.default_action]);

    if (semantics === "first_match") {
      let decision = defaultDecision;
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const rule = active[index];
        decision = this.z.If(this.ruleFormula(rule), this.z.Int.val(ACTION_SEVERITY[rule.action]), decision);
      }
      return decision;
    }

    // Under most-restrictive semantics, the default action is a fallback used
    // only when no rule matches. It must not compete with matching rule actions.
    let strongestMatchingAction = this.z.Int.val(ACTION_SEVERITY.Permit);
    const matchFormulas = [];
    for (const rule of active) {
      const matches = this.ruleFormula(rule);
      matchFormulas.push(matches);
      const severity = this.z.Int.val(ACTION_SEVERITY[rule.action]);
      strongestMatchingAction = this.z.If(
        matches,
        this.z.If(severity.gt(strongestMatchingAction), severity, strongestMatchingAction),
        strongestMatchingAction
      );
    }
    return this.z.If(this.or(matchFormulas), strongestMatchingAction, defaultDecision);
  }

  // Central query layer. Every SMT query goes through here so that SAT, UNSAT
  // and UNKNOWN outcomes are counted. Solver errors are not caught: they
  // propagate to the caller and abort the analysis.
  async solve(formulas, check = "query", subject = null) {
    const solver = this.createSolver(check, subject);
    if (this.queryTimeoutMs !== null) solver.set("timeout", this.queryTimeoutMs);
    solver.add(...this.domainConstraints, ...formulas);
    const status = await solver.check();
    const name = resultName(status);
    this.recordQuery(check, subject, name, solver);
    this.emitProgress("query", false);
    if (name !== "sat") {
      solver.release();
      return { status: name, witness: null, model: null };
    }
    const model = solver.model();
    const witness = this.modelToWitness(model);
    return { status: name, witness, model, solver };
  }

  recordQuery(check, subject, status, solver) {
    const stats = this.queryStats;
    const bucket = (stats.by_check[check] ??= { sat: 0, unsat: 0, unknown: 0 });
    stats.total += 1;
    if (status === "sat" || status === "unsat") {
      stats[status] += 1;
      bucket[status] += 1;
      return;
    }
    // Anything other than sat/unsat is inconclusive. It is never read as UNSAT
    // and never as "checked, no finding".
    stats.unknown += 1;
    bucket.unknown += 1;
    let reason = null;
    try {
      reason = typeof solver.reasonUnknown === "function" ? String(solver.reasonUnknown()) : null;
    } catch {
      reason = null;
    }
    stats.inconclusive.push({ check, subject, status, reason_unknown: reason });
  }

  emitProgress(event, force) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < this.progressIntervalMs) return;
    this.lastProgressAt = now;
    const stats = this.queryStats;
    this.onProgress({
      event,
      stage: this.stage,
      elapsed_ms: this.analysisStartedAt === null ? null : Number(process.hrtime.bigint() - this.analysisStartedAt) / 1e6,
      queries: { total: stats.total, sat: stats.sat, unsat: stats.unsat, unknown: stats.unknown },
      by_check: structuredClone(stats.by_check)
    });
  }

  modelToWitness(model) {
    const witness = {};
    for (const [attribute, values] of Object.entries(this.policy.domains)) {
      const raw = Number(model.eval(this.variables[attribute], true).value());
      witness[attribute] = values[raw];
    }
    witness.size_mb = Number(model.eval(this.variables.size_mb, true).value());
    return witness;
  }

  matchingRuleIds(model, rules = this.policy.rules) {
    return rules
      .filter(rule => String(model.eval(this.ruleFormula(rule), true)) === "true")
      .map(rule => rule.id);
  }

  closeSolution(solution) {
    if (solution?.solver) solution.solver.release();
  }

  async analyze(options = {}) {
    const semantics = options.semantics ?? this.policy.semantics;
    const types = new Set(options.types ?? [
      "action_conflict",
      "shadowing",
      "redundancy",
      "coverage_gap",
      "exception_leakage",
      "semantic_divergence"
    ]);
    const findings = [];
    this.queryStats = emptyQueryStats();
    const startedAt = process.hrtime.bigint();
    this.analysisStartedAt = startedAt;
    const checkElapsedMs = {};
    const runCheck = async (name, enabled, check) => {
      if (!enabled) return;
      this.stage = name;
      this.emitProgress("stage_start", true);
      const checkStart = process.hrtime.bigint();
      findings.push(...(await check()));
      checkElapsedMs[name] = Number(process.hrtime.bigint() - checkStart) / 1e6;
      this.emitProgress("stage_end", true);
    };

    await runCheck("action_conflict", types.has("action_conflict"), () => this.findActionConflicts());
    await runCheck("shadowing", types.has("shadowing") && semantics === "first_match", () => this.findShadowing());
    await runCheck("redundancy", types.has("redundancy"), () => this.findRedundancy(semantics));
    await runCheck("coverage_gap", types.has("coverage_gap"), () => this.findCoverageGaps(semantics));
    await runCheck("exception_leakage", types.has("exception_leakage"), () => this.findExceptionLeakage(semantics));
    await runCheck("semantic_divergence", types.has("semantic_divergence"), () => this.findSemanticDivergence());
    this.stage = "done";

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const stats = this.queryStats;
    const complete = stats.unknown === 0;
    return {
      policy: this.policy.name,
      semantics,
      // "complete" means every query returned SAT or UNSAT. Only then does the
      // absence of a finding establish the corresponding property.
      analysis_status: complete ? "complete" : "incomplete",
      complete,
      query_stats: {
        total: stats.total,
        sat: stats.sat,
        unsat: stats.unsat,
        unknown: stats.unknown,
        by_check: stats.by_check
      },
      inconclusive_queries: stats.inconclusive,
      rule_count: this.policy.rules.length,
      requirement_count: this.policy.requirements.length,
      elapsed_ms: elapsedMs,
      // Wall-clock time of each check inside analyze(); their sum is slightly
      // below elapsed_ms (stage bookkeeping is excluded).
      check_elapsed_ms: checkElapsedMs,
      query_timeout_ms: this.queryTimeoutMs,
      finding_count: findings.length,
      counts: Object.fromEntries(
        [...types].map(type => [type, findings.filter(finding => finding.type === type).length])
      ),
      findings
    };
  }

  async findActionConflicts() {
    const findings = [];
    const rules = this.policy.rules.filter(rule => rule.enabled);
    for (let left = 0; left < rules.length; left += 1) {
      for (let right = left + 1; right < rules.length; right += 1) {
        const first = rules[left];
        const second = rules[right];
        if (first.action === second.action || !clausesMayOverlap(first.conditions, second.conditions, this.policy)) continue;
        const [leftRule, rightRule] = canonicalRuleIds(first.id, second.id)[0] === first.id
          ? [first, second]
          : [second, first];
        const solution = await this.solve(
          [this.ruleFormula(first), this.ruleFormula(second)],
          "action_conflict",
          `${leftRule.id}|${rightRule.id}`
        );
        if (solution.status === "sat") {
          findings.push({
            id: findingId("action_conflict", leftRule.id, rightRule.id),
            type: "action_conflict",
            rules: [leftRule.id, rightRule.id],
            actions: [leftRule.action, rightRule.action],
            evidence_kind: "witness",
            witness: solution.witness,
            explanation: `${leftRule.id} and ${rightRule.id} match the same transfer but prescribe ${leftRule.action} and ${rightRule.action}.`
          });
        }
        this.closeSolution(solution);
      }
    }
    return findings;
  }

  async findShadowing() {
    const findings = [];
    const ordered = this.policy.rules
      .filter(rule => rule.enabled)
      .sort(compareRules);
    for (let index = 1; index < ordered.length; index += 1) {
      const rule = ordered[index];
      const previous = ordered.slice(0, index).filter(candidate =>
        clausesMayOverlap(candidate.conditions, rule.conditions, this.policy)
      );
      if (previous.length === 0) continue;
      const reachable = await this.solve([
        this.ruleFormula(rule),
        this.z.Not(this.or(previous.map(candidate => this.ruleFormula(candidate))))
      ], "shadowing_reachability", rule.id);
      if (reachable.status === "unsat") {
        // UNSAT alone would also hold for an empty match set; the second query
        // confirms that the rule matches at least one valid event.
        const proof = await this.solve([
          this.ruleFormula(rule),
          this.or(previous.map(candidate => this.ruleFormula(candidate)))
        ], "shadowing_representative", rule.id);
        if (proof.status === "sat") {
          const coveringSet = previous.map(candidate => candidate.id);
          const representativeMatches = this.matchingRuleIds(proof.model, previous);
          findings.push({
            id: findingId("shadowing", rule.id),
            type: "shadowing",
            rule: rule.id,
            // Established by the UNSAT query: the union of these earlier rules
            // covers every event the rule can match. The set is not minimised.
            covering_rule_set: coveringSet,
            // Only the earlier rules that match the representative event. This
            // list alone is not claimed to cover the rule's match set.
            representative_event_matching_rules: representativeMatches,
            evidence_kind: "representative_event",
            witness: proof.witness,
            explanation: `${rule.id} is unreachable under first-match evaluation: every event it matches is also matched by at least one earlier rule in {${coveringSet.join(", ")}} (UNSAT). The representative event is matched by ${representativeMatches.join(", ")}.`
          });
        }
        this.closeSolution(proof);
      }
      this.closeSolution(reachable);
    }
    return findings;
  }

  async findRedundancy(semantics) {
    const findings = [];
    for (const rule of this.policy.rules.filter(item => item.enabled)) {
      const overlapping = this.policy.rules.filter(item =>
        item.enabled &&
        item.id !== rule.id &&
        clausesMayOverlap(item.conditions, rule.conditions, this.policy)
      );

      if (
        overlapping.length === 0 &&
        rule.exceptions.length === 0 &&
        rule.action !== this.policy.default_action
      ) {
        continue;
      }

      const localRules = [rule, ...overlapping];
      const reducedRules = overlapping;
      const full = this.decisionExpression(localRules, semantics);
      const reduced = this.decisionExpression(reducedRules, semantics);
      const difference = await this.solve([this.ruleFormula(rule), full.neq(reduced)], "redundancy_difference", rule.id);
      if (difference.status === "unsat") {
        // Excludes rules with an empty match set (UNSAT would hold vacuously).
        const example = await this.solve([this.ruleFormula(rule)], "redundancy_representative", rule.id);
        if (example.status === "sat") {
          findings.push({
            id: findingId("redundancy", rule.id),
            type: "redundancy",
            rule: rule.id,
            evidence_kind: "representative_event",
            witness: example.witness,
            explanation: `Removing ${rule.id} does not change the policy decision for any valid transfer under ${semantics} semantics.`
          });
        }
        this.closeSolution(example);
      }
      this.closeSolution(difference);
    }
    return findings;
  }

  async findCoverageGaps(semantics) {
    const findings = [];
    for (const requirement of this.policy.requirements) {
      const relevantRules = this.policy.rules.filter(rule =>
        rule.enabled && clausesMayOverlap(rule.conditions, requirement.conditions, this.policy)
      );
      const decision = this.decisionExpression(relevantRules, semantics);
      const minimum = ACTION_SEVERITY[requirement.minimum_action];
      // UNSAT means no valid event in the requirement scope falls below the
      // minimum. For an empty scope this holds vacuously; it does not mean that
      // any protected event exists.
      const solution = await this.solve([
        this.clauseFormula(requirement.conditions),
        decision.lt(minimum)
      ], "coverage_gap", requirement.id);
      if (solution.status === "sat") {
        const actual = Number(solution.model.eval(decision, true).value());
        findings.push({
          id: findingId("coverage_gap", requirement.id),
          type: "coverage_gap",
          requirement: requirement.id,
          minimum_action: requirement.minimum_action,
          effective_action: actionFromSeverity(actual),
          evidence_kind: "counterexample",
          witness: solution.witness,
          explanation: `${requirement.id} requires at least ${requirement.minimum_action}, but the counterexample is evaluated as ${actionFromSeverity(actual)}.`
        });
      }
      this.closeSolution(solution);
    }
    return findings;
  }

  async findExceptionLeakage(semantics) {
    const findings = [];
    for (const rule of this.policy.rules.filter(item => item.enabled && item.exceptions.length > 0)) {
      for (let exceptionIndex = 0; exceptionIndex < rule.exceptions.length; exceptionIndex += 1) {
        const exception = rule.exceptions[exceptionIndex];
        for (const requirement of this.policy.requirements) {
          const relevantRules = this.policy.rules.filter(candidate =>
            candidate.enabled && clausesMayOverlap(candidate.conditions, requirement.conditions, this.policy)
          );
          const decision = this.decisionExpression(relevantRules, semantics);
          const minimum = ACTION_SEVERITY[requirement.minimum_action];
          // Exception-linked requirement violation: an event inside the rule's
          // conditions, the exception and the requirement scope whose effective
          // decision is below the minimum. It does not establish that removing
          // the exception would remove the violation (no counterfactual query).
          const solution = await this.solve([
            this.ruleBaseFormula(rule),
            this.clauseFormula(exception),
            this.clauseFormula(requirement.conditions),
            decision.lt(minimum)
          ], "exception_leakage", `${rule.id}:${exceptionIndex}:${requirement.id}`);
          if (solution.status === "sat") {
            const actual = Number(solution.model.eval(decision, true).value());
            findings.push({
              id: findingId("exception_leakage", rule.id, String(exceptionIndex), requirement.id),
              type: "exception_leakage",
              rule: rule.id,
              exception_index: exceptionIndex,
              requirement: requirement.id,
              minimum_action: requirement.minimum_action,
              effective_action: actionFromSeverity(actual),
              evidence_kind: "counterexample",
              witness: solution.witness,
              explanation: `Exception ${exceptionIndex} of ${rule.id} admits a transfer in the scope of ${requirement.id} whose effective action is ${actionFromSeverity(actual)}, below the required ${requirement.minimum_action} (exception-linked requirement violation; removal of the exception is not shown to remove it).`
            });
          }
          this.closeSolution(solution);
        }
      }
    }
    return findings;
  }

  async findSemanticDivergence() {
    const first = this.decisionExpression(this.policy.rules, "first_match");
    const restrictive = this.decisionExpression(this.policy.rules, "most_restrictive");
    const solution = await this.solve([first.neq(restrictive)], "semantic_divergence", null);
    if (solution.status !== "sat") {
      this.closeSolution(solution);
      return [];
    }
    const firstValue = Number(solution.model.eval(first, true).value());
    const restrictiveValue = Number(solution.model.eval(restrictive, true).value());
    const matching = this.matchingRuleIds(solution.model);
    const finding = {
      id: findingId("semantic_divergence"),
      type: "semantic_divergence",
      matched_rules: matching,
      first_match_action: actionFromSeverity(firstValue),
      most_restrictive_action: actionFromSeverity(restrictiveValue),
      evidence_kind: "witness",
      witness: solution.witness,
      explanation: `The same transfer is evaluated as ${actionFromSeverity(firstValue)} under first-match and ${actionFromSeverity(restrictiveValue)} under most-restrictive semantics.`
    };
    this.closeSolution(solution);
    return [finding];
  }
}

function emptyQueryStats() {
  return { total: 0, sat: 0, unsat: 0, unknown: 0, by_check: {}, inconclusive: [] };
}

export function findingId(type, ...parts) {
  return [type, ...parts].join(":");
}

export function actionFromSeverity(value) {
  return Object.entries(ACTION_SEVERITY).find(([, severity]) => severity === value)?.[0] ?? `Unknown(${value})`;
}

export function clausesMayOverlap(left, right, policy) {
  for (const attribute of Object.keys(policy.domains)) {
    const leftValues = allowedValues(left[attribute], policy.domains[attribute]);
    const rightValues = allowedValues(right[attribute], policy.domains[attribute]);
    if (!leftValues.some(value => rightValues.includes(value))) return false;
  }

  const [globalMin, globalMax] = policy.numeric_limits.size_mb;
  const leftRange = numericRange(left.size_mb, globalMin, globalMax);
  const rightRange = numericRange(right.size_mb, globalMin, globalMax);
  return Math.max(leftRange[0], rightRange[0]) <= Math.min(leftRange[1], rightRange[1]);
}

function allowedValues(constraint, domain) {
  if (constraint === undefined || constraint === "*") return domain;
  return Array.isArray(constraint) ? constraint : [constraint];
}

function numericRange(constraint, globalMin, globalMax) {
  if (constraint === undefined) return [globalMin, globalMax];
  if (typeof constraint === "number") return [constraint, constraint];
  return [constraint.min ?? globalMin, constraint.max ?? globalMax];
}
