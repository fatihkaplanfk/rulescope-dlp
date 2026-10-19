// One dense-overlap run in its own process.
//
// Usage: node worker.mjs <n> <density> <seed> <queryTimeoutMs> <progressIntervalMs> <progress.jsonl> <result.json>
//
// Progress lines (JSONL, appended synchronously so they survive a kill):
//   process_start, init_done, stage_start/stage_end/query (from the analyzer),
//   analysis_done, failed.
// "wall_ms" is the time since this process started (process.uptime), so it
// includes module loading and Z3 initialisation. "analysis_ms" is measured
// inside analyze() and excludes them. No line can be written while a single
// solver query is running; the gap is bounded only by the query timeout.

import { appendFileSync, writeFileSync } from "node:fs";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../../src/analyzer.js";
import { generateDenseOverlapPolicy, PARAMS } from "./generator.mjs";

const [nArg, density, seedArg, timeoutArg, intervalArg, progressPath, resultPath] = process.argv.slice(2);
const n = Number(nArg);
const seed = Number(seedArg);
const queryTimeoutMs = Number(timeoutArg);
const progressIntervalMs = Number(intervalArg);
const wallMs = () => process.uptime() * 1000;
const log = record => appendFileSync(progressPath, `${JSON.stringify({ wall_ms: wallMs(), ...record })}\n`);

log({ event: "process_start" });
let api;
try {
  const generated = generateDenseOverlapPolicy(n, density, seed);
  api = await z3Solver.init();
  const analyzer = new DlpAnalyzer(api.Context, generated.policy, `dense_${n}_${density}_${seed}`, {
    queryTimeoutMs,
    progressIntervalMs,
    onProgress: event => log({ event: event.event, stage: event.stage, analysis_ms: event.elapsed_ms,
      queries: event.queries, by_check: event.by_check })
  });
  log({ event: "init_done" });
  const report = await analyzer.analyze({ types: PARAMS.analysis_types });
  log({ event: "analysis_done", analysis_ms: report.elapsed_ms, queries: report.query_stats,
    complete: report.complete });
  writeFileSync(resultPath, `${JSON.stringify({
    n, density, seed, query_timeout_ms: queryTimeoutMs,
    process_wall_ms_at_end: wallMs(),
    // Peak resident set size reported by Node (process.resourceUsage().maxRSS,
    // kilobytes). Not validated on this platform; kept for information only.
    max_rss_kb_unvalidated: process.resourceUsage().maxRSS,
    report
  })}\n`);
} catch (error) {
  log({ event: "failed", message: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  api?.em.PThread?.terminateAllThreads?.();
}
