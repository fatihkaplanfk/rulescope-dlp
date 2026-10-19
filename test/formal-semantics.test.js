// Edge cases of the formal model raised in the SAUCIS review.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../src/analyzer.js";
import { analyzeByRandomTesting } from "../src/baseline.js";
import { clauseMatches, evaluatePolicy, ruleMatches } from "../src/evaluator.js";
import { compareIds, compareRules } from "../src/ordering.js";
import { ACTION_SEVERITY, loadAndValidatePolicy } from "../src/schema.js";

let api;
before(async () => {
  api = await z3Solver.init();
});
after(() => {
  api?.em.PThread?.terminateAllThreads?.();
});

const analyze = (policy, options = {}) => new DlpAnalyzer(api.Context, policy, `fs_${Math.random()}`).analyze(options);
const ids = report => report.findings.map(f => f.id).sort();

const baseEvent = {
  user_group: "Finance", data_classification: "Restricted", content_type: "Document", channel: "Web",
  destination_trust: "Untrusted", device_trust: "Managed", file_type: "PDF", size_mb: 10
};

// ---------------------------------------------------------------- shadowing
test("shadowing by the union of two earlier rules; neither alone covers the rule", async () => {
  const policy = loadAndValidatePolicy({
    domains: { device_trust: ["Managed", "Unmanaged"] },
    rules: [
      { id: "A", priority: 1, conditions: { channel: "Web", device_trust: "Managed" }, action: "Audit" },
      { id: "B", priority: 2, conditions: { channel: "Web", device_trust: "Unmanaged" }, action: "Warn" },
      { id: "C", priority: 3, conditions: { channel: "Web" }, action: "Block" }
    ]
  });
  const report = await analyze(policy, { types: ["shadowing"] });
  const finding = report.findings.find(f => f.id === "shadowing:C");
  assert.ok(finding, "C must be reported as shadowed");
  assert.equal(report.complete, true);
  assert.deepEqual([...finding.covering_rule_set].sort(), ["A", "B"]);
  assert.equal(finding.evidence_kind, "representative_event");
  // The representative event is matched by exactly one of the two earlier rules.
  assert.equal(finding.representative_event_matching_rules.length, 1);
  assert.equal(finding.shadowed_by, undefined, "the ambiguous shadowed_by field is no longer emitted");
  // Neither A nor B alone shadows C.
  for (const keep of ["A", "B"]) {
    const single = loadAndValidatePolicy({ ...policy, rules: policy.rules.filter(r => r.id === keep || r.id === "C") });
    assert.deepEqual(ids(await analyze(single, { types: ["shadowing"] })), []);
  }
});

// ------------------------------------------------------------ canonical ids
test("conflict ids do not depend on the order of rules in the policy array", async () => {
  const rules = [
    { id: "Zeta", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
    { id: "alpha", priority: 2, conditions: { channel: "Web" }, action: "Block" },
    { id: "Beta", priority: 3, conditions: { channel: "Web", file_type: "PDF" }, action: "Encrypt" }
  ];
  const forward = loadAndValidatePolicy({ rules });
  const reversed = loadAndValidatePolicy({ rules: [...rules].reverse() });
  const conflicts = async policy => ids(await analyze(policy, { types: ["action_conflict"] }));
  const expected = ["action_conflict:Beta:Zeta", "action_conflict:Beta:alpha", "action_conflict:Zeta:alpha"];
  assert.deepEqual(await conflicts(forward), expected);
  assert.deepEqual(await conflicts(reversed), expected);
  const randomConflicts = policy => analyzeByRandomTesting(policy, { samples: 4000, seed: 3 }).findings
    .filter(f => f.type === "action_conflict").map(f => f.id).sort();
  assert.deepEqual(randomConflicts(forward), expected);
  assert.deepEqual(randomConflicts(reversed), expected);
});

test("equal-priority tie-break is ordinal (code-unit) id order, not locale order", () => {
  assert.ok(compareIds("B", "a") < 0, "'B' (U+0042) precedes 'a' (U+0061) ordinally");
  assert.ok(compareIds("R10", "R9") < 0);
  const policy = loadAndValidatePolicy({
    rules: [
      { id: "a", priority: 5, conditions: { channel: "Web" }, action: "Audit" },
      { id: "B", priority: 5, conditions: { channel: "Web" }, action: "Block" }
    ]
  });
  assert.deepEqual([...policy.rules].sort(compareRules).map(r => r.id), ["B", "a"]);
  assert.equal(evaluatePolicy(policy, baseEvent, "first_match").action, "Block");
});

// --------------------------------------------- empty match sets and scopes
test("rules with an empty effective match set are not reported as shadowed or redundant", async () => {
  const policy = loadAndValidatePolicy({
    rules: [
      { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
      { id: "EMPTY_RANGE", priority: 2, conditions: { channel: "Web", size_mb: { min: 50, max: 10 } }, action: "Audit" },
      { id: "EMPTY_EXC", priority: 3, conditions: { channel: "Web" }, exceptions: [{}], action: "Audit" },
      { id: "EMPTY_LIST", priority: 4, conditions: { channel: [] }, action: "Audit" }
    ]
  });
  const report = await analyze(policy, { types: ["shadowing", "redundancy"] });
  assert.equal(report.complete, true);
  for (const id of ["EMPTY_RANGE", "EMPTY_EXC", "EMPTY_LIST"]) {
    assert.ok(!report.findings.some(f => f.rule === id), `${id} must not be reported`);
  }
});

test("an empty requirement scope produces no violation (vacuously satisfied)", async () => {
  const policy = loadAndValidatePolicy({
    default_action: "Permit",
    rules: [],
    requirements: [{ id: "EMPTY_SCOPE", conditions: { channel: "USB", size_mb: { min: 100, max: 50 } }, minimum_action: "Block" }]
  });
  const report = await analyze(policy, { types: ["coverage_gap"] });
  assert.equal(report.complete, true);
  assert.deepEqual(report.findings, []);
  // Vacuous: no event satisfies the scope, so no protected event exists either.
  assert.equal(clauseMatches(policy.requirements[0].conditions, { ...baseEvent, channel: "USB", size_mb: 75 }), false);
});

test("an empty exception object excludes every event (concrete and symbolic)", async () => {
  const policy = loadAndValidatePolicy({
    default_action: "Permit",
    rules: [{ id: "R1", priority: 1, conditions: { channel: "Web" }, exceptions: {}, action: "Block" }]
  });
  assert.deepEqual(policy.rules[0].exceptions, [{}]);
  assert.equal(ruleMatches(policy.rules[0], baseEvent), false);
  assert.equal(evaluatePolicy(policy, baseEvent, "first_match").action, "Permit");
  const analyzer = new DlpAnalyzer(api.Context, policy, "fs_empty_exception");
  const solution = await analyzer.solve([analyzer.ruleFormula(policy.rules[0])], "test");
  assert.equal(solution.status, "unsat");
});

// ----------------------------------------------------------------- priority
test("missing priority defaults to position; an explicit invalid priority is rejected", () => {
  const ok = loadAndValidatePolicy({ rules: [{ id: "R1", action: "Audit" }, { id: "R2", action: "Block" }] });
  assert.deepEqual(ok.rules.map(r => r.priority), [1, 2]);
  for (const bad of ["high", 1.5, null, "3"]) {
    assert.throws(
      () => loadAndValidatePolicy({ rules: [{ id: "R1", priority: bad, action: "Audit" }] }),
      /Priority of R1 must be an integer/,
      `priority ${JSON.stringify(bad)} must be rejected`
    );
  }
});

// -------------------------------------------------------- exception leakage
test("exception-linked violation is reported even when the rule's own action is insufficient", async () => {
  const policy = loadAndValidatePolicy({
    default_action: "Permit",
    rules: [{ id: "R1", priority: 1, conditions: { channel: "Web" }, exceptions: [{ user_group: "Executive" }], action: "Audit" }],
    requirements: [{ id: "REQ", conditions: { channel: "Web" }, minimum_action: "Block" }]
  });
  const report = await analyze(policy, { types: ["coverage_gap", "exception_leakage"] });
  const leak = report.findings.find(f => f.id === "exception_leakage:R1:0:REQ");
  assert.ok(leak, "an exception-linked violation is reported");
  assert.ok(report.findings.some(f => f.id === "coverage_gap:REQ"), "the gap exists independently of the exception");
  // Removing the exception does not remove the violation: R1 itself is only Audit.
  const withoutException = loadAndValidatePolicy({ ...policy, rules: [{ ...policy.rules[0], exceptions: [] }] });
  assert.ok(ACTION_SEVERITY[evaluatePolicy(withoutException, leak.witness, "first_match").action] < ACTION_SEVERITY.Block);
  // The leakage event also satisfies the coverage-gap query of the same requirement.
  assert.equal(clauseMatches(policy.requirements[0].conditions, leak.witness), true);
  assert.ok(ACTION_SEVERITY[evaluatePolicy(policy, leak.witness, "first_match").action] < ACTION_SEVERITY.Block);
  assert.equal(leak.evidence_kind, "counterexample");
});
