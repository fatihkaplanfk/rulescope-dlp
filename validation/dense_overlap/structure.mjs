// Solver-free structural measurements of a dense-overlap policy.
//
// P_all   enabled rule pairs
// P_diff  enabled rule pairs with different actions
// C_all   pairs passing the overlap prefilter (clausesMayOverlap) -- a
//         candidate count, NOT a true-overlap count
// C_diff  different-action pairs passing the prefilter (= number of
//         action-conflict queries the analyzer issues)
// G_all   pairs sharing an anchor; both rules match the anchor event
//         effectively (verified with the concrete evaluator), so these pairs
//         certainly overlap: a lower bound on true overlap
// G_diff  different-action pairs sharing an anchor
// Per-check candidate sizes mirror the prefilter use in src/analyzer.js.

import { clausesMayOverlap } from "../../src/analyzer.js";
import { clauseMatches, ruleMatches } from "../../src/evaluator.js";
import { compareRules } from "../../src/ordering.js";

export function measureStructure({ policy, anchors, anchorOf, requirementAnchorOf }) {
  const rules = policy.rules.filter(rule => rule.enabled);
  const n = rules.length;

  // Concrete check of the anchor guarantee.
  const anchorFailures = rules.filter(rule => !ruleMatches(rule, anchors[anchorOf[rule.id]])).map(r => r.id);
  const requirementFailures = policy.requirements
    .filter(req => !clauseMatches(req.conditions, anchors[requirementAnchorOf[req.id]])).map(r => r.id);

  let pAll = 0, pDiff = 0, cAll = 0, cDiff = 0, gAll = 0, gDiff = 0, gNotCandidate = 0;
  const overlap = rules.map(() => []);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = rules[i];
      const b = rules[j];
      const different = a.action !== b.action;
      const candidate = clausesMayOverlap(a.conditions, b.conditions, policy);
      const sharedAnchor = anchorOf[a.id] === anchorOf[b.id];
      pAll += 1;
      if (different) pDiff += 1;
      if (candidate) {
        cAll += 1;
        if (different) cDiff += 1;
        overlap[i].push(j);
        overlap[j].push(i);
      }
      if (sharedAnchor) {
        gAll += 1;
        if (different) gDiff += 1;
        if (!candidate) gNotCandidate += 1; // would contradict prefilter soundness
      }
    }
  }

  // Shadowing: earlier overlapping rules in first-match order.
  const order = [...rules].sort(compareRules);
  const position = new Map(order.map((rule, index) => [rule.id, index]));
  const indexOf = new Map(rules.map((rule, index) => [rule.id, index]));
  let shadowQueries = 0, shadowCandidateSum = 0, shadowCandidateMax = 0;
  for (let k = 1; k < order.length; k += 1) {
    const earlier = overlap[indexOf.get(order[k].id)].filter(j => position.get(rules[j].id) < k).length;
    if (earlier > 0) {
      shadowQueries += 1;
      shadowCandidateSum += earlier;
      shadowCandidateMax = Math.max(shadowCandidateMax, earlier);
    }
  }

  // Redundancy: overlapping rules; skipped when no overlap, no exception and action != default.
  let redundancyQueries = 0, redundancyCandidateSum = 0, redundancyCandidateMax = 0;
  rules.forEach((rule, i) => {
    const count = overlap[i].length;
    if (count === 0 && rule.exceptions.length === 0 && rule.action !== policy.default_action) return;
    redundancyQueries += 1;
    redundancyCandidateSum += count;
    redundancyCandidateMax = Math.max(redundancyCandidateMax, count);
  });

  const relevantPerRequirement = policy.requirements.map(req =>
    rules.filter(rule => clausesMayOverlap(rule.conditions, req.conditions, policy)).length);
  const rulesWithExceptions = rules.filter(rule => rule.exceptions.length > 0);
  const exceptionCount = rulesWithExceptions.reduce((sum, rule) => sum + rule.exceptions.length, 0);

  return {
    n,
    anchors: anchors.length,
    anchor_group_sizes: { min: Math.min(...groupSizes(rules, anchorOf)), max: Math.max(...groupSizes(rules, anchorOf)) },
    anchor_check: { rules_not_matching_anchor: anchorFailures, requirements_not_containing_anchor: requirementFailures },
    pairs: {
      P_all: pAll, P_diff: pDiff, C_all: cAll, C_diff: cDiff, G_all: gAll, G_diff: gDiff,
      prefilter_candidate_ratio_all: pAll ? cAll / pAll : 0,
      prefilter_candidate_ratio_diff: pDiff ? cDiff / pDiff : 0,
      shared_anchor_pairs_failing_prefilter: gNotCandidate
    },
    candidates: {
      action_conflict_queries: cDiff,
      shadowing_reachability_queries: shadowQueries,
      shadowing_candidate_sum: shadowCandidateSum,
      shadowing_candidate_max: shadowCandidateMax,
      redundancy_difference_queries: redundancyQueries,
      redundancy_candidate_sum: redundancyCandidateSum,
      redundancy_candidate_max: redundancyCandidateMax,
      coverage_gap_queries: policy.requirements.length,
      coverage_gap_relevant_rules: relevantPerRequirement,
      exception_leakage_queries: exceptionCount * policy.requirements.length,
      rules_with_exceptions: rulesWithExceptions.length
    }
  };
}

function groupSizes(rules, anchorOf) {
  const counts = new Map();
  for (const rule of rules) counts.set(anchorOf[rule.id], (counts.get(anchorOf[rule.id]) ?? 0) + 1);
  return [...counts.values()];
}
