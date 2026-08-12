import { ACTION_SEVERITY } from "./schema.js";
import { clauseMatches, evaluatePolicy, ruleMatches } from "./evaluator.js";
import { findingId } from "./analyzer.js";

export function analyzeByRandomTesting(policy, options = {}) {
  const samples = options.samples ?? 10000;
  const random = mulberry32(options.seed ?? 1);
  const events = Array.from({ length: samples }, () => randomEvent(policy, random));
  const findings = [];
  const ordered = policy.rules
    .filter(rule => rule.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

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
          const ids = [matching[left].id, matching[right].id].sort();
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

  return { samples, findings, finding_count: findings.length };
}

export function randomEvent(policy, random = Math.random) {
  const event = {};
  for (const [attribute, values] of Object.entries(policy.domains)) {
    event[attribute] = values[Math.floor(random() * values.length)];
  }
  const [minimum, maximum] = policy.numeric_limits.size_mb;
  event.size_mb = Math.floor(minimum + random() * (maximum - minimum + 1));
  return event;
}

export function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let current = value;
    current = Math.imul(current ^ (current >>> 15), current | 1);
    current ^= current + Math.imul(current ^ (current >>> 7), current | 61);
    return ((current ^ (current >>> 14)) >>> 0) / 4294967296;
  };
}
