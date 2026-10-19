// Optional analyzer instrumentation: per-query timeout, per-check timing and
// progress events. The defaults must keep the original behaviour.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../src/analyzer.js";
import { loadAndValidatePolicy } from "../src/schema.js";

let api;
before(async () => {
  api = await z3Solver.init();
});
after(() => {
  api?.em.PThread?.terminateAllThreads?.();
});

const policy = () => loadAndValidatePolicy({
  rules: [
    { id: "R1", priority: 1, conditions: { channel: "Web" }, action: "Audit" },
    { id: "R2", priority: 2, conditions: { channel: "Web", user_group: "HR" }, action: "Audit" },
    { id: "R3", priority: 3, conditions: { channel: "Web", file_type: "PDF" }, exceptions: [{ user_group: "Executive" }], action: "Block" }
  ],
  requirements: [{ id: "REQ1", conditions: { channel: "Web", file_type: "PDF" }, minimum_action: "Block" }]
});

function spySetCalls(analyzer) {
  const calls = [];
  const real = analyzer.createSolver;
  analyzer.createSolver = (check, subject) => {
    const solver = real(check, subject);
    const original = solver.set.bind(solver);
    solver.set = (key, value) => {
      calls.push([key, value]);
      return original(key, value);
    };
    return solver;
  };
  return calls;
}

const ALL_CHECKS = ["action_conflict", "shadowing", "redundancy", "coverage_gap", "exception_leakage", "semantic_divergence"];

test("default: no solver timeout is set and the report shape is unchanged apart from new fields", async () => {
  const analyzer = new DlpAnalyzer(api.Context, policy(), "opt_default");
  const calls = spySetCalls(analyzer);
  const report = await analyzer.analyze();
  assert.deepEqual(calls, []);
  assert.equal(report.query_timeout_ms, null);
  assert.deepEqual(Object.keys(report.check_elapsed_ms), ALL_CHECKS);
  assert.ok(Object.values(report.check_elapsed_ms).every(ms => ms >= 0));
  const sum = Object.values(report.check_elapsed_ms).reduce((a, b) => a + b, 0);
  assert.ok(sum <= report.elapsed_ms + 1e-6);
});

test("queryTimeoutMs sets the solver timeout on every query without changing the findings", async () => {
  const plain = await new DlpAnalyzer(api.Context, policy(), "opt_plain").analyze();
  const analyzer = new DlpAnalyzer(api.Context, policy(), "opt_timeout", { queryTimeoutMs: 1234 });
  const calls = spySetCalls(analyzer);
  const report = await analyzer.analyze();
  assert.equal(calls.length, report.query_stats.total);
  assert.ok(calls.every(([key, value]) => key === "timeout" && value === 1234));
  assert.equal(report.query_timeout_ms, 1234);
  assert.deepEqual(report.findings.map(f => f.id), plain.findings.map(f => f.id));
  assert.deepEqual(report.query_stats, plain.query_stats);
});

test("only the checks that run are timed (shadowing is skipped under most-restrictive)", async () => {
  const report = await new DlpAnalyzer(api.Context, policy(), "opt_mr").analyze({ semantics: "most_restrictive" });
  assert.deepEqual(Object.keys(report.check_elapsed_ms), ALL_CHECKS.filter(c => c !== "shadowing"));
});

test("progress events report stages and query counts; the last event matches the report", async () => {
  const events = [];
  const analyzer = new DlpAnalyzer(api.Context, policy(), "opt_progress", {
    onProgress: event => events.push(event),
    progressIntervalMs: 0
  });
  const report = await analyzer.analyze();
  for (const check of ALL_CHECKS) {
    assert.ok(events.some(e => e.event === "stage_start" && e.stage === check), `${check} start`);
    assert.ok(events.some(e => e.event === "stage_end" && e.stage === check), `${check} end`);
  }
  assert.ok(events.filter(e => e.event === "query").length === report.query_stats.total);
  const last = events.at(-1);
  assert.equal(last.queries.total, report.query_stats.total);
  assert.deepEqual(last.by_check, report.query_stats.by_check);
  assert.ok(events.every(e => typeof e.elapsed_ms === "number"));
});

test("progress events are throttled between queries but stage events are always emitted", async () => {
  const events = [];
  const analyzer = new DlpAnalyzer(api.Context, policy(), "opt_throttle", {
    onProgress: event => events.push(event),
    progressIntervalMs: 60_000
  });
  await analyzer.analyze();
  assert.equal(events.filter(e => e.event === "query").length, 0);
  assert.equal(events.filter(e => e.event === "stage_start").length, ALL_CHECKS.length);
});
