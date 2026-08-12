import { ACTION_SEVERITY } from "./schema.js";

export function clauseMatches(clause, event) {
  return Object.entries(clause).every(([attribute, constraint]) => {
    if (attribute === "size_mb") {
      if (typeof constraint === "number") return event.size_mb === constraint;
      const min = constraint.min ?? Number.NEGATIVE_INFINITY;
      const max = constraint.max ?? Number.POSITIVE_INFINITY;
      return event.size_mb >= min && event.size_mb <= max;
    }
    if (constraint === "*" || constraint === undefined) return true;
    const allowed = Array.isArray(constraint) ? constraint : [constraint];
    return allowed.includes(event[attribute]);
  });
}

export function ruleMatches(rule, event) {
  if (!rule.enabled || !clauseMatches(rule.conditions, event)) return false;
  return !rule.exceptions.some(exception => clauseMatches(exception, event));
}

export function evaluatePolicy(policy, event, semantics = policy.semantics, omitRuleId = null) {
  const matching = policy.rules
    .filter(rule => rule.id !== omitRuleId && ruleMatches(rule, event))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  if (matching.length === 0) {
    return { action: policy.default_action, matched_rules: [], applied_rules: [] };
  }

  if (semantics === "first_match") {
    return {
      action: matching[0].action,
      matched_rules: matching.map(rule => rule.id),
      applied_rules: [matching[0].id]
    };
  }

  const maximum = Math.max(...matching.map(rule => ACTION_SEVERITY[rule.action]));
  const applied = matching.filter(rule => ACTION_SEVERITY[rule.action] === maximum);
  return {
    action: applied[0].action,
    matched_rules: matching.map(rule => rule.id),
    applied_rules: applied.map(rule => rule.id)
  };
}

export function eventSatisfiesRequirement(event, requirement) {
  return clauseMatches(requirement.conditions, event);
}
