// UNKNOWN and solver-error handling.
//
// These tests use a test double for the solver. They do not claim that the
// real Z3 solver produces UNKNOWN for these policies; they check how the
// analyzer treats an UNKNOWN result when one occurs.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../src/analyzer.js";
import { formatTextReport } from "../src/report.js";
import { loadAndValidatePolicy } from "../src/schema.js";

let api;
before(async () => {
  api = await z3Solver.init();
});
after(() => {
  api?.em.PThread?.terminateAllThreads?.();
});

// Policy with one shadowed rule (R2), one conflict (R1/R3) and one gap (REQ1).
const policy = () => loadAndValidatePolicy({
  default_action: "Permit",
  rules: [
    { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
    { id: "R2", priority: 2, conditions: { channel: "Web", user_group: "HR" }, action: "Audit" },
    { id: "R3", priority: 3, conditions: { channel: "Web", file_type: "PDF" }, action: "Block" }
  ],
  requirements: [{ id: "REQ1", conditions: { channel: "USB" }, minimum_action: "Block" }]
});

// Test double: answers UNKNOWN for selected checks, delegates others to Z3.
function forceUnknown(analyzer, shouldForce) {
  const real = analyzer.createSolver;
  analyzer.createSolver = (check, subject) => {
    if (!shouldForce(check, subject)) return real(check, subject);
    return {
      add() {},
      async check() { return "unknown"; },
      reasonUnknown() { return "test double: forced unknown"; },
      model() { throw new Error("no model for UNKNOWN"); },
      release() {}
    };
  };
}

test("baseline: all queries conclusive, report complete", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_baseline");
  const report = await analyzer.analyze();
  assert.equal(report.complete, true);
  assert.equal(report.analysis_status, "complete");
  assert.equal(report.query_stats.unknown, 0);
  assert.equal(report.query_stats.total, report.query_stats.sat + report.query_stats.unsat);
  const ids = report.findings.map(f => f.id);
  assert.ok(ids.includes("shadowing:R2"));
  assert.ok(ids.includes("action_conflict:R1:R3"));
  assert.ok(ids.includes("coverage_gap:REQ1"));
});

test("UNKNOWN in every query: no finding, report incomplete, reason kept", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_all_unknown");
  forceUnknown(analyzer, () => true);
  const report = await analyzer.analyze();
  assert.equal(report.findings.length, 0);
  assert.equal(report.complete, false);
  assert.equal(report.analysis_status, "incomplete");
  assert.equal(report.query_stats.sat + report.query_stats.unsat, 0);
  assert.equal(report.query_stats.unknown, report.query_stats.total);
  assert.ok(report.inconclusive_queries.length > 0);
  assert.ok(report.inconclusive_queries.every(q => q.reason_unknown === "test double: forced unknown"));
  const text = formatTextReport(report);
  assert.match(text, /ANALYSIS INCOMPLETE/);
  assert.doesNotMatch(text, /No anomalies were found/);
});

test("UNKNOWN in the shadowing reachability query is not read as UNSAT", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_shadow_unknown");
  forceUnknown(analyzer, check => check === "shadowing_reachability");
  const report = await analyzer.analyze({ types: ["shadowing"] });
  assert.equal(report.findings.length, 0, "an UNKNOWN reachability query must not produce a shadowing finding");
  assert.equal(report.complete, false);
  assert.ok(report.inconclusive_queries.some(q => q.check === "shadowing_reachability" && q.subject === "R2"));
});

test("UNKNOWN in the redundancy difference query is not read as UNSAT", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_redundancy_unknown");
  forceUnknown(analyzer, check => check === "redundancy_difference");
  const report = await analyzer.analyze({ types: ["redundancy"] });
  assert.equal(report.findings.length, 0);
  assert.equal(report.complete, false);
});

test("UNKNOWN in one SAT-type check marks the whole report incomplete; other findings remain", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_gap_unknown");
  forceUnknown(analyzer, check => check === "coverage_gap");
  const report = await analyzer.analyze();
  const ids = report.findings.map(f => f.id);
  assert.ok(!ids.includes("coverage_gap:REQ1"));
  assert.ok(ids.includes("shadowing:R2"));
  assert.equal(report.complete, false);
  assert.deepEqual(report.query_stats.by_check.coverage_gap, { sat: 0, unsat: 0, unknown: 1 });
});

test("solver errors propagate instead of being treated as a result", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "qs_error");
  analyzer.createSolver = () => ({
    add() {},
    async check() { throw new Error("simulated solver failure"); },
    release() {}
  });
  await assert.rejects(analyzer.analyze(), /simulated solver failure/);
});
