// Query-status census for the formal-model fixes (Reviewer 2).
//
// Runs the current analyzer on the 50 controlled policies (same analysis types
// as experiments/benchmark-worker.js), on the five SPEDIA policy variants (all
// analysis types, as experiments/run-spedia-replay.js) and on the example
// policy. Records finding ids, SAT/UNSAT/UNKNOWN counts and completeness. Also
// checks whether any policy contains equal rule priorities, the only case in
// which the tie-break change can alter a decision.
//
// Usage: node validation/formal_model_fixes/query_stats.mjs <out.json>

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z3Solver from "z3-solver";
import { generateBenchmarkPolicy } from "../../benchmark/generator.js";
import { buildSpediaPolicies } from "../../experiments/spedia-policy.js";
import { DlpAnalyzer } from "../../src/analyzer.js";
import { loadAndValidatePolicy } from "../../src/schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2];
const BENCHMARK_TYPES = ["action_conflict", "shadowing", "redundancy", "coverage_gap", "exception_leakage"];
const api = await z3Solver.init();
const rows = [];

function tieGroups(policy) {
  const seen = new Map();
  for (const rule of policy.rules.filter(r => r.enabled)) seen.set(rule.priority, (seen.get(rule.priority) ?? 0) + 1);
  return [...seen.values()].filter(count => count > 1).length;
}

async function run(kind, label, policy, options, expected) {
  const analyzer = new DlpAnalyzer(api.Context, policy, `qs_${kind}_${label}`);
  const report = await analyzer.analyze(options);
  const ids = report.findings.map(f => f.id).sort();
  rows.push({
    kind, label,
    rules: policy.rules.length,
    equal_priority_groups: tieGroups(policy),
    analysis_status: report.analysis_status,
    query_stats: report.query_stats,
    inconclusive_queries: report.inconclusive_queries,
    finding_ids: ids,
    expected_ids: expected ? [...expected].sort() : null,
    matches_expected: expected ? JSON.stringify(ids) === JSON.stringify([...expected].sort()) : null
  });
}

try {
  for (const size of [50, 100, 250, 500, 1000]) {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { policy, expectedFindingIds } = generateBenchmarkPolicy(size, seed);
      await run("benchmark", `n${size}_seed${seed}`, policy, { types: BENCHMARK_TYPES }, expectedFindingIds);
    }
  }
  for (const variant of buildSpediaPolicies()) {
    await run("spedia", variant.id, variant.policy, {}, null);
  }
  const sample = loadAndValidatePolicy(JSON.parse(await readFile(resolve(root, "examples", "sample-policy.json"), "utf8")));
  await run("example", "sample-policy", sample, {}, null);
} finally {
  api.em.PThread?.terminateAllThreads?.();
}

await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
const totals = rows.reduce((acc, row) => {
  acc.total += row.query_stats.total; acc.sat += row.query_stats.sat;
  acc.unsat += row.query_stats.unsat; acc.unknown += row.query_stats.unknown;
  return acc;
}, { total: 0, sat: 0, unsat: 0, unknown: 0 });
console.log(JSON.stringify({ analyses: rows.length, ...totals,
  incomplete: rows.filter(r => r.analysis_status !== "complete").length,
  benchmark_matches: rows.filter(r => r.matches_expected).length }));
