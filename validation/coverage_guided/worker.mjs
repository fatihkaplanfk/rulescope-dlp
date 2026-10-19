// One controlled-benchmark run: uniform random (unchanged src/baseline.js)
// and coverage-guided baselines on the same policy, in the same process.
//
// Usage: node validation/coverage_guided/worker.mjs <size> <seed> <budget>
// Prints one JSON object. Ground-truth ids are used only for scoring after
// both baselines have finished.

import { performance } from "node:perf_hooks";
import { generateBenchmarkPolicy } from "../../benchmark/generator.js";
import { analyzeByRandomTesting, mulberry32, randomEvent } from "../../src/baseline.js";
import { coverageOfEvents, observeFindings, runCoverageGuided, summarizeCoverage } from "./coverage_guided.mjs";

const [size, seed, budget] = process.argv.slice(2).map(Number);
const { policy, expectedFindingIds } = generateBenchmarkPolicy(size, seed);
const randomSeed = seed * 1009 + size;            // identical to experiments/benchmark-worker.js
const guidedSeed = seed * 1009 + size + 104729;   // separate, fixed stream for the coverage-guided search

// Alternate execution order by seed parity so that JIT warm-up does not favour one arm.
const order = seed % 2 === 1 ? ["random", "guided"] : ["guided", "random"];
const timed = {};
for (const arm of order) {
  if (arm === "random") {
    const start = performance.now();
    const result = analyzeByRandomTesting(policy, { samples: budget, seed: randomSeed });
    timed.random = { result, elapsed_ms: performance.now() - start };
  } else {
    const start = performance.now();
    const result = runCoverageGuided(policy, { budget, seed: guidedSeed });
    timed.guided = { result, elapsed_ms: performance.now() - start };
  }
}

// ---- untimed checks and coverage of the uniform-random event set
const rng = mulberry32(randomSeed);
const randomEvents = Array.from({ length: budget }, () => randomEvent(policy, rng));
const copied = observeFindings(policy, randomEvents).findings.map(f => f.id);
const original = timed.random.result.findings.map(f => f.id);
const observationCopyIdentical = JSON.stringify(copied) === JSON.stringify(original);
const randomCoverage = summarizeCoverage(coverageOfEvents(policy, randomEvents));

const expected = [...expectedFindingIds].sort();
const guidedIds = timed.guided.result.findings.map(f => f.id).sort();
const randomIds = [...original].sort();

process.stdout.write(JSON.stringify({
  size,
  seed,
  budget,
  execution_order: order,
  random_seed: randomSeed,
  guided_seed: guidedSeed,
  observation_copy_identical: observationCopyIdentical,
  expected_ids: expected,
  random: {
    ids: randomIds,
    evaluated_events: budget,
    elapsed_ms: timed.random.elapsed_ms,
    coverage: randomCoverage,
    ...metrics(expected, randomIds)
  },
  guided: {
    ids: guidedIds,
    evaluated_events: timed.guided.result.evaluated_events,
    elapsed_ms: timed.guided.elapsed_ms,
    corpus_size: timed.guided.result.corpus_size,
    last_new_coverage_at: timed.guided.result.last_new_coverage_at,
    operations: timed.guided.result.operations,
    coverage: timed.guided.result.coverage,
    ...metrics(expected, guidedIds)
  }
}));

// Same definitions as experiments/benchmark-worker.js classificationMetrics, plus raw counts.
function metrics(expectedIds, observedIds) {
  const expectedSet = new Set(expectedIds);
  const observedSet = new Set(observedIds);
  const tp = [...observedSet].filter(id => expectedSet.has(id)).length;
  const fp = [...observedSet].filter(id => !expectedSet.has(id)).length;
  const fn = [...expectedSet].filter(id => !observedSet.has(id)).length;
  const precision = tp + fp === 0 ? (expectedSet.size === 0 ? 1 : 0) : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1, false_positive_ids: [...observedSet].filter(id => !expectedSet.has(id)) };
}
