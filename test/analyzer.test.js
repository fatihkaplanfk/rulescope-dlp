import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import z3Solver from "z3-solver";
import { generateBenchmarkPolicy } from "../benchmark/generator.js";
import { DlpAnalyzer } from "../src/analyzer.js";
import { loadAndValidatePolicy } from "../src/schema.js";

let api;

before(async () => {
  api = await z3Solver.init();
});

after(() => {
  api?.em.PThread?.terminateAllThreads?.();
});

test("SMT analysis recovers every planted anomaly without false positives", async () => {
  const { policy, expectedFindingIds } = generateBenchmarkPolicy(50, 7);
  const analyzer = new DlpAnalyzer(api.Context, policy, "test_ground_truth");
  const report = await analyzer.analyze({
    types: ["action_conflict", "shadowing", "redundancy", "coverage_gap", "exception_leakage"]
  });
  assert.deepEqual(
    new Set(report.findings.map(finding => finding.id)),
    expectedFindingIds
  );
});

test("every reported anomaly includes an explainable witness", async () => {
  const { policy } = generateBenchmarkPolicy(50, 9);
  const analyzer = new DlpAnalyzer(api.Context, policy, "test_witness");
  const report = await analyzer.analyze({
    types: ["action_conflict", "shadowing", "redundancy", "coverage_gap", "exception_leakage"]
  });
  for (const finding of report.findings) {
    assert.ok(finding.witness, `${finding.id} did not include a witness`);
    assert.equal(typeof finding.witness.channel, "string");
    assert.equal(typeof finding.witness.size_mb, "number");
  }
});

test("symbolic most-restrictive semantics do not compare a matching rule with the default action", async () => {
  const policy = loadAndValidatePolicy({
    semantics: "first_match",
    default_action: "Block",
    rules: [
      { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" }
    ]
  });
  const analyzer = new DlpAnalyzer(api.Context, policy, "test_default_fallback");
  const findings = await analyzer.findSemanticDivergence();
  assert.deepEqual(findings, []);
});
