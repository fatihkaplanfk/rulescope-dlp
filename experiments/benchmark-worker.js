import { performance } from "node:perf_hooks";
import z3Solver from "z3-solver";
import { generateBenchmarkPolicy } from "../benchmark/generator.js";
import { DlpAnalyzer } from "../src/analyzer.js";
import { analyzeByRandomTesting } from "../src/baseline.js";

const [sizeArg, seedArg, samplesArg] = process.argv.slice(2);
const size = Number(sizeArg);
const seed = Number(seedArg);
const samples = Number(samplesArg);
const { policy, expectedFindingIds } = generateBenchmarkPolicy(size, seed);
const api = await z3Solver.init();

try {
  const analyzer = new DlpAnalyzer(api.Context, policy, `benchmark_${size}_${seed}`);
  const exact = await analyzer.analyze({
    types: ["action_conflict", "shadowing", "redundancy", "coverage_gap", "exception_leakage"]
  });
  const rssAfterExactMb = process.memoryUsage().rss / (1024 * 1024);

  const baselineStart = performance.now();
  const random = analyzeByRandomTesting(policy, { samples, seed: seed * 1009 + size });
  const baselineElapsedMs = performance.now() - baselineStart;

  const expected = [...expectedFindingIds].sort();
  const exactIds = exact.findings.map(finding => finding.id).sort();
  const randomIds = random.findings.map(finding => finding.id).sort();
  const exactMetrics = classificationMetrics(expected, exactIds);
  const randomMetrics = classificationMetrics(expected, randomIds);

  process.stdout.write(JSON.stringify({
    size,
    seed,
    samples,
    expected_ids: expected,
    exact_ids: exactIds,
    random_ids: randomIds,
    exact: {
      elapsed_ms: exact.elapsed_ms,
      rss_mb: rssAfterExactMb,
      ...exactMetrics
    },
    random: {
      elapsed_ms: baselineElapsedMs,
      rss_mb: process.memoryUsage().rss / (1024 * 1024),
      ...randomMetrics
    },
    representative_findings: exact.findings
  }));
} finally {
  api.em.PThread?.terminateAllThreads?.();
}

function classificationMetrics(expectedIds, observedIds) {
  const expected = new Set(expectedIds);
  const observed = new Set(observedIds);
  const tp = [...observed].filter(id => expected.has(id)).length;
  const fp = [...observed].filter(id => !expected.has(id)).length;
  const fn = [...expected].filter(id => !observed.has(id)).length;
  const precision = tp + fp === 0 ? (expected.size === 0 ? 1 : 0) : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}
