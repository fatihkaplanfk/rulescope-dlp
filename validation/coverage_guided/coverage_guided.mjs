// Coverage-guided testing baseline for the controlled benchmark (Reviewer 2).
//
// The baseline uses only concrete execution feedback from the existing
// first-match evaluator. It never sees ground-truth finding identifiers,
// planted-defect ids, SMT output, witnesses or counterexamples. Its input is
// the normalized policy object alone.
//
// Finding observation (observeFindings) is a verbatim copy of the observation
// part of analyzeByRandomTesting in src/baseline.js, with event generation
// removed so that the same definitions can be applied to any event list. The
// worker checks, for every run, that observeFindings() on the uniform-random
// events reproduces analyzeByRandomTesting() exactly.

import { ACTION_SEVERITY } from "../../src/schema.js";
import { clauseMatches, evaluatePolicy, ruleMatches } from "../../src/evaluator.js";
import { findingId } from "../../src/analyzer.js";
import { mulberry32, randomEvent } from "../../src/baseline.js";
import { canonicalRuleIds, compareRules } from "../../src/ordering.js";

export const DEFAULTS = Object.freeze({
  budget: 10000,          // evaluated events per policy (same as uniform random)
  seedCorpus: 100,        // initial uniform-random events
  freshProbability: 0.1,  // chance a candidate is a fresh uniform event instead of a mutant
  maxOps: 3,              // mutations per candidate: uniform in 1..maxOps
  opWeights: { categorical: 0.45, splice: 0.25, size: 0.30 }
});

// ---------------------------------------------------------------- coverage
export function makeContext(policy) {
  const ordered = policy.rules
    .filter(rule => rule.enabled)
    .sort(compareRules);
  return {
    policy,
    ordered,
    withExceptions: ordered.filter(rule => rule.exceptions.length > 0)
  };
}

// Coverage keys produced by one concrete evaluation.
export function coverageKeys(ctx, event) {
  const { policy } = ctx;
  const keys = [];
  const matching = ctx.ordered.filter(rule => ruleMatches(rule, event));
  for (const rule of matching) keys.push(`m:${rule.id}`);                 // rule matched
  const decision = evaluatePolicy(policy, event, "first_match");
  keys.push(`f:${decision.applied_rules[0] ?? "<default>"}`);             // first-match selection
  for (let i = 0; i < matching.length; i += 1) {
    for (let j = i + 1; j < matching.length; j += 1) {
      const ids = canonicalRuleIds(matching[i].id, matching[j].id);
      keys.push(`p:${ids[0]}|${ids[1]}`);                                  // rule-pair co-match
    }
  }
  for (const requirement of policy.requirements) {
    if (!clauseMatches(requirement.conditions, event)) continue;
    keys.push(`r:${requirement.id}`);                                      // requirement scope reached
    if (ACTION_SEVERITY[decision.action] < ACTION_SEVERITY[requirement.minimum_action]) {
      keys.push(`v:${requirement.id}`);                                    // requirement violation observed
    }
  }
  for (const rule of ctx.withExceptions) {
    if (!clauseMatches(rule.conditions, event)) continue;
    rule.exceptions.forEach((exception, index) => {
      if (clauseMatches(exception, event)) keys.push(`x:${rule.id}:${index}`); // exception triggered
    });
  }
  keys.push(`a:${decision.action}`);                                       // distinct final action
  return keys;
}

export function summarizeCoverage(keys) {
  const byKind = { m: 0, f: 0, p: 0, r: 0, v: 0, x: 0, a: 0 };
  for (const key of keys) byKind[key[0]] += 1;
  return {
    rules_matched: byKind.m,
    first_match_selected: byKind.f,
    rule_pairs_co_matched: byKind.p,
    requirement_scopes_reached: byKind.r,
    requirement_violations_observed: byKind.v,
    exceptions_triggered: byKind.x,
    distinct_final_actions: byKind.a,
    total_coverage_keys: keys.size ?? keys.length
  };
}

export function coverageOfEvents(policy, events) {
  const ctx = makeContext(policy);
  const covered = new Set();
  for (const event of events) for (const key of coverageKeys(ctx, event)) covered.add(key);
  return covered;
}

// --------------------------------------------------------------- mutation
function sizeBoundaries(policy) {
  const [lo, hi] = policy.numeric_limits.size_mb;
  const values = new Set([lo, hi]);
  const clauses = [
    ...policy.rules.flatMap(rule => [rule.conditions, ...rule.exceptions]),
    ...policy.requirements.map(requirement => requirement.conditions)
  ];
  for (const clause of clauses) {
    const constraint = clause.size_mb;
    if (constraint === undefined || constraint === "*") continue;
    const points = typeof constraint === "number"
      ? [constraint]
      : [constraint.min, constraint.max].filter(value => value !== undefined);
    for (const point of points) for (const delta of [-1, 0, 1]) values.add(point + delta);
  }
  return [...values].filter(value => value >= lo && value <= hi).sort((a, b) => a - b);
}

// Clauses whose declared constraints can be spliced into an event. Only the
// conditions themselves are read; rule ids, descriptions and actions are not.
function spliceClauses(policy) {
  return [
    ...policy.rules.filter(rule => rule.enabled).flatMap(rule => [rule.conditions, ...rule.exceptions]),
    ...policy.requirements.map(requirement => requirement.conditions)
  ].map(clause => Object.entries(clause).filter(([, constraint]) => constraint !== "*" && constraint !== undefined))
    .filter(entries => entries.length > 0);
}

function pick(items, random) {
  return items[Math.floor(random() * items.length)];
}

function clampSize(policy, value) {
  const [lo, hi] = policy.numeric_limits.size_mb;
  return Math.min(hi, Math.max(lo, value));
}

function mutateCategorical(policy, event, random) {
  const attribute = pick(Object.keys(policy.domains), random);
  const values = policy.domains[attribute].filter(value => value !== event[attribute]);
  if (values.length > 0) event[attribute] = pick(values, random);
}

function mutateSize(policy, event, random, boundaries) {
  const [lo, hi] = policy.numeric_limits.size_mb;
  const roll = random();
  if (roll < 0.5) event.size_mb = pick(boundaries, random);                      // boundary value
  else if (roll < 0.75) {
    const delta = (1 + Math.floor(random() * 16)) * (random() < 0.5 ? -1 : 1);   // small step
    event.size_mb = clampSize(policy, event.size_mb + delta);
  } else event.size_mb = Math.floor(lo + random() * (hi - lo + 1));              // uniform
}

function mutateSplice(policy, event, random, clauses) {
  if (clauses.length === 0) return;
  const entries = [...pick(clauses, random)];
  const count = 1 + Math.floor(random() * entries.length);
  for (let i = entries.length - 1; i > 0; i -= 1) {                             // partial shuffle
    const j = Math.floor(random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  for (const [attribute, constraint] of entries.slice(0, count)) {
    if (attribute === "size_mb") {
      if (typeof constraint === "number") event.size_mb = clampSize(policy, constraint);
      else {
        const [lo, hi] = policy.numeric_limits.size_mb;
        const min = Math.max(lo, constraint.min ?? lo);
        const max = Math.min(hi, constraint.max ?? hi);
        if (min <= max) event.size_mb = Math.floor(min + random() * (max - min + 1));
      }
      continue;
    }
    const value = Array.isArray(constraint) ? pick(constraint, random) : constraint;
    if (policy.domains[attribute]?.includes(value)) event[attribute] = value;     // never leave the domain
  }
}

// ------------------------------------------------------------- the search
export function runCoverageGuided(policy, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const random = mulberry32(settings.seed ?? 1);
  const ctx = makeContext(policy);
  const boundaries = sizeBoundaries(policy);
  const clauses = spliceClauses(policy);
  const weights = settings.opWeights;
  const covered = new Set();
  const corpus = [];
  const evaluated = [];
  let lastNewCoverageAt = 0;
  const opsUsed = { categorical: 0, splice: 0, size: 0, fresh: 0 };

  const evaluate = candidate => {
    evaluated.push(candidate);
    let isNew = false;
    for (const key of coverageKeys(ctx, candidate)) {
      if (!covered.has(key)) {
        covered.add(key);
        isNew = true;
      }
    }
    if (isNew) {
      corpus.push(candidate);
      lastNewCoverageAt = evaluated.length;
    }
  };

  const seedCount = Math.min(settings.seedCorpus, settings.budget);
  for (let i = 0; i < seedCount; i += 1) evaluate(randomEvent(policy, random));

  while (evaluated.length < settings.budget) {
    let candidate;
    if (corpus.length === 0 || random() < settings.freshProbability) {
      candidate = randomEvent(policy, random);
      opsUsed.fresh += 1;
    } else {
      candidate = { ...pick(corpus, random) };
      const operations = 1 + Math.floor(random() * settings.maxOps);
      for (let i = 0; i < operations; i += 1) {
        const roll = random();
        if (roll < weights.categorical) {
          mutateCategorical(policy, candidate, random);
          opsUsed.categorical += 1;
        } else if (roll < weights.categorical + weights.splice) {
          mutateSplice(policy, candidate, random, clauses);
          opsUsed.splice += 1;
        } else {
          mutateSize(policy, candidate, random, boundaries);
          opsUsed.size += 1;
        }
      }
    }
    evaluate(candidate);
  }

  const observed = observeFindings(policy, evaluated);
  return {
    evaluated_events: evaluated.length,
    corpus_size: corpus.length,
    last_new_coverage_at: lastNewCoverageAt,
    operations: opsUsed,
    coverage: summarizeCoverage(covered),
    findings: observed.findings,
    events: evaluated
  };
}

// ------------------------------------------- observation (copied verbatim)
// Identical to the observation logic of analyzeByRandomTesting (src/baseline.js),
// with `events` passed in instead of generated.
export function observeFindings(policy, events) {
  const findings = [];
  const ordered = policy.rules
    .filter(rule => rule.enabled)
    .sort(compareRules);

  const observations = new Map(ordered.map(rule => [rule.id, { matched: 0, applied: 0, changed: 0 }]));
  const conflicts = new Set();

  for (const event of events) {
    const matching = ordered.filter(rule => ruleMatches(rule, event));
    for (const rule of matching) observations.get(rule.id).matched += 1;
    const decision = evaluatePolicy(policy, event, "first_match");
    decision.applied_rules.forEach(id => observations.get(id).applied += 1);

    for (let left = 0; left < matching.length; left += 1) {
      for (let right = left + 1; right < matching.length; right += 1) {
        if (matching[left].action !== matching[right].action) {
          const ids = canonicalRuleIds(matching[left].id, matching[right].id);
          conflicts.add(findingId("action_conflict", ...ids));
        }
      }
    }

    for (const rule of matching) {
      const without = evaluatePolicy(policy, event, "first_match", rule.id);
      if (without.action !== decision.action) observations.get(rule.id).changed += 1;
    }
  }

  for (const id of conflicts) findings.push({ id, type: "action_conflict" });
  for (const rule of ordered) {
    const stats = observations.get(rule.id);
    if (stats.matched >= 1 && stats.applied === 0) {
      findings.push({ id: findingId("shadowing", rule.id), type: "shadowing" });
    }
    if (stats.matched >= 1 && stats.changed === 0) {
      findings.push({ id: findingId("redundancy", rule.id), type: "redundancy" });
    }
  }

  for (const requirement of policy.requirements) {
    const matchingEvents = events.filter(event => clauseMatches(requirement.conditions, event));
    const gap = matchingEvents.find(event =>
      ACTION_SEVERITY[evaluatePolicy(policy, event, "first_match").action] < ACTION_SEVERITY[requirement.minimum_action]
    );
    if (gap) findings.push({ id: findingId("coverage_gap", requirement.id), type: "coverage_gap" });
  }

  for (const rule of ordered.filter(item => item.exceptions.length > 0)) {
    rule.exceptions.forEach((exception, exceptionIndex) => {
      for (const requirement of policy.requirements) {
        const leaked = events.some(event =>
          clauseMatches(rule.conditions, event) &&
          clauseMatches(exception, event) &&
          clauseMatches(requirement.conditions, event) &&
          ACTION_SEVERITY[evaluatePolicy(policy, event, "first_match").action] < ACTION_SEVERITY[requirement.minimum_action]
        );
        if (leaked) {
          findings.push({
            id: findingId("exception_leakage", rule.id, String(exceptionIndex), requirement.id),
            type: "exception_leakage"
          });
        }
      }
    });
  }

  return { findings, finding_count: findings.length };
}
