// Shared, environment-independent ordering used by the symbolic analyzer, the
// concrete evaluator and the testing baselines.
//
// Identifiers are compared by UTF-16 code units (the same order as
// Array.prototype.sort without a comparator). Unlike String.prototype.localeCompare,
// this order does not depend on the runtime's locale or ICU data.

export function compareIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// First-match evaluation order: ascending priority, ties broken by rule id.
export function compareRules(left, right) {
  return left.priority - right.priority || compareIds(left.id, right.id);
}

// Canonical order of the rule ids that make up an unordered finding (e.g. an
// action conflict between two rules), independent of their position in the policy.
export function canonicalRuleIds(...ids) {
  return [...ids].sort(compareIds);
}
