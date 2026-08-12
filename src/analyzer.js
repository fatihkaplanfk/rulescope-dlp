import { ACTION_SEVERITY } from "./schema.js";

function resultName(result) {
  return String(result);
}

export class DlpAnalyzer {
  constructor(Context, policy, contextName = `policylint_${Date.now()}`) {
    this.policy = policy;
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
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
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

  async solve(formulas) {
    const solver = new this.z.Solver();
    solver.add(...this.domainConstraints, ...formulas);
    const status = await solver.check();
    const name = resultName(status);
    if (name !== "sat") {
      solver.release();
      return { status: name, witness: null, model: null };
    }
    const model = solver.model();
    const witness = this.modelToWitness(model);
    return { status: name, witness, model, solver };
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
    const startedAt = process.hrtime.bigint();

    if (types.has("action_conflict")) findings.push(...(await this.findActionConflicts()));
    if (types.has("shadowing") && semantics === "first_match") findings.push(...(await this.findShadowing()));
    if (types.has("redundancy")) findings.push(...(await this.findRedundancy(semantics)));
    if (types.has("coverage_gap")) findings.push(...(await this.findCoverageGaps(semantics)));
    if (types.has("exception_leakage")) findings.push(...(await this.findExceptionLeakage(semantics)));
    if (types.has("semantic_divergence")) findings.push(...(await this.findSemanticDivergence()));

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      policy: this.policy.name,
      semantics,
      rule_count: this.policy.rules.length,
      requirement_count: this.policy.requirements.length,
      elapsed_ms: elapsedMs,
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
        const solution = await this.solve([this.ruleFormula(first), this.ruleFormula(second)]);
        if (solution.status === "sat") {
          findings.push({
            id: findingId("action_conflict", first.id, second.id),
            type: "action_conflict",
            rules: [first.id, second.id],
            actions: [first.action, second.action],
            witness: solution.witness,
            explanation: `${first.id} and ${second.id} match the same transfer but prescribe ${first.action} and ${second.action}.`
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
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (let index = 1; index < ordered.length; index += 1) {
      const rule = ordered[index];
      const previous = ordered.slice(0, index).filter(candidate =>
        clausesMayOverlap(candidate.conditions, rule.conditions, this.policy)
      );
      if (previous.length === 0) continue;
      const reachable = await this.solve([
        this.ruleFormula(rule),
        this.z.Not(this.or(previous.map(candidate => this.ruleFormula(candidate))))
      ]);
      if (reachable.status === "unsat") {
        const proof = await this.solve([
          this.ruleFormula(rule),
          this.or(previous.map(candidate => this.ruleFormula(candidate)))
        ]);
        if (proof.status === "sat") {
          const blockers = this.matchingRuleIds(proof.model, previous);
          findings.push({
            id: findingId("shadowing", rule.id),
            type: "shadowing",
            rule: rule.id,
            shadowed_by: blockers,
            witness: proof.witness,
            explanation: `${rule.id} is unreachable under first-match evaluation because earlier rule(s) ${blockers.join(", ")} cover every event it can match.`
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
      const difference = await this.solve([this.ruleFormula(rule), full.neq(reduced)]);
      if (difference.status === "unsat") {
        const example = await this.solve([this.ruleFormula(rule)]);
        if (example.status === "sat") {
          findings.push({
            id: findingId("redundancy", rule.id),
            type: "redundancy",
            rule: rule.id,
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
      const solution = await this.solve([
        this.clauseFormula(requirement.conditions),
        decision.lt(minimum)
      ]);
      if (solution.status === "sat") {
        const actual = Number(solution.model.eval(decision, true).value());
        findings.push({
          id: findingId("coverage_gap", requirement.id),
          type: "coverage_gap",
          requirement: requirement.id,
          minimum_action: requirement.minimum_action,
          effective_action: actionFromSeverity(actual),
          witness: solution.witness,
          explanation: `${requirement.id} requires at least ${requirement.minimum_action}, but the witness is evaluated as ${actionFromSeverity(actual)}.`
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
          const solution = await this.solve([
            this.ruleBaseFormula(rule),
            this.clauseFormula(exception),
            this.clauseFormula(requirement.conditions),
            decision.lt(minimum)
          ]);
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
              witness: solution.witness,
              explanation: `Exception ${exceptionIndex} in ${rule.id} admits a transfer protected by ${requirement.id}; its effective action falls to ${actionFromSeverity(actual)}.`
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
    const solution = await this.solve([first.neq(restrictive)]);
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
      witness: solution.witness,
      explanation: `The same transfer is evaluated as ${actionFromSeverity(firstValue)} under first-match and ${actionFromSeverity(restrictiveValue)} under most-restrictive semantics.`
    };
    this.closeSolution(solution);
    return [finding];
  }
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
