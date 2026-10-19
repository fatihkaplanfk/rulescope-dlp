// Dense-overlap scalability: structural phase + pilot (12 runs).
//
// Usage: node validation/dense_overlap/run_pilot.mjs
//
// Writes to validation/output/dense_overlap/ (refuses to overwrite):
//   run_manifest.json   environment, dependency versions, git state, source
//                       hash manifest, frozen parameters, seeds, run order
//   structure.json      solver-free pair and candidate counts (50..1000 rules)
//   pilot/<run>/progress.jsonl, pilot/<run>/result.json (full analyzer report)
//   pilot_runs.csv, pilot_report.md
// Does not start any run beyond the 12 pilot runs.

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../../src/baseline.js";
import { generateDenseOverlapPolicy, PARAMS } from "./generator.mjs";
import { measureStructure } from "./structure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const outDir = resolve(root, "validation", "output", "dense_overlap");
const pilotDir = resolve(outDir, "pilot");
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  throw new Error(`${outDir} already exists and is not empty; refusing to overwrite.`);
}
mkdirSync(pilotDir, { recursive: true });

// ------------------------------------------------------------- manifest
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceFiles = [
  ...readdirSync(resolve(root, "src")).map(f => `src/${f}`),
  "benchmark/generator.js", "package.json", "package-lock.json",
  ...readdirSync(here).filter(f => /\.(mjs|json)$/.test(f)).map(f => `validation/dense_overlap/${f}`)
].sort();
const git = args => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } };
const p = PARAMS.pilot;
const plan = [];
for (const n of p.sizes) for (const density of p.densities) for (const seed of p.seeds) plan.push({ n, density, seed });
const orderRandom = mulberry32(p.run_order_seed);
for (let i = plan.length - 1; i > 0; i -= 1) {
  const j = Math.floor(orderRandom() * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}
const manifest = {
  created_utc: new Date().toISOString(),
  environment: {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length,
    total_memory_gib: +(os.totalmem() / 2 ** 30).toFixed(2),
    node: process.version,
    z3_solver: JSON.parse(readFileSync(resolve(root, "node_modules/z3-solver/package.json"), "utf8")).version
  },
  git: { head: git(["rev-parse", "HEAD"]), dirty_files: (git(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean) },
  source_sha256: Object.fromEntries(sourceFiles.map(f => [f, sha(resolve(root, f))])),
  params: PARAMS,
  pilot_run_order: plan.map(r => `n${r.n}_${r.density}_s${r.seed}`)
};
writeFileSync(resolve(outDir, "run_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------------------------------------------------- structural phase
const structure = [];
const s = PARAMS.structural_only;
const structureStart = Date.now();
for (const n of s.sizes) for (const density of s.densities) for (const seed of s.seeds) {
  const generated = generateDenseOverlapPolicy(n, density, seed);
  structure.push({ n, density, seed, exceptions_assigned: generated.exceptions_assigned,
    exceptions_target: generated.exceptions_target, ...measureStructure(generated) });
}
const structureMs = Date.now() - structureStart;
writeFileSync(resolve(outDir, "structure.json"), `${JSON.stringify(structure, null, 2)}\n`);
const anchorProblems = structure.filter(r => r.anchor_check.rules_not_matching_anchor.length ||
  r.anchor_check.requirements_not_containing_anchor.length || r.pairs.shared_anchor_pairs_failing_prefilter);
if (anchorProblems.length) throw new Error(`Anchor guarantee violated: ${JSON.stringify(anchorProblems.map(r => [r.n, r.density, r.seed]))}`);
console.log(`structural phase: ${structure.length} policies in ${structureMs} ms; anchor guarantee holds`);

// --------------------------------------------------------- pilot runs
const runs = [];
for (const item of plan) {
  const id = `n${item.n}_${item.density}_s${item.seed}`;
  const dir = resolve(pilotDir, id);
  mkdirSync(dir);
  const progressPath = resolve(dir, "progress.jsonl");
  const resultPath = resolve(dir, "result.json");
  writeFileSync(progressPath, "");
  const started = Date.now();
  const child = spawnSync(process.execPath, [resolve(here, "worker.mjs"), String(item.n), item.density, String(item.seed),
    String(p.query_timeout_ms), String(p.progress_interval_ms), progressPath, resultPath],
  { cwd: root, encoding: "utf8", timeout: p.wall_clock_limit_ms, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  const processWallMs = Date.now() - started;
  const progress = readFileSync(progressPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const last = progress.at(-1) ?? null;
  const lastWithQueries = [...progress].reverse().find(e => e.queries) ?? null;
  const timedOut = child.error?.code === "ETIMEDOUT" || child.signal === "SIGKILL";
  let status, result = null;
  if (timedOut) status = "aborted_wall_clock";
  else if (child.status === 0 && existsSync(resultPath)) {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
    status = result.report.complete ? "complete" : "incomplete_unknown";
  } else status = "failed";
  if (child.stderr) writeFileSync(resolve(dir, "stderr.txt"), child.stderr);
  const struct = structure.find(r => r.n === item.n && r.density === item.density && r.seed === item.seed);
  runs.push({ id, ...item, status, process_wall_ms: processWallMs, exit_code: child.status, signal: child.signal,
    last_event: last && { event: last.event, stage: last.stage, wall_ms: last.wall_ms },
    last_queries: lastWithQueries?.queries ?? null, last_by_check: lastWithQueries?.by_check ?? null,
    report: result?.report ?? null, max_rss_kb_unvalidated: result?.max_rss_kb_unvalidated ?? null, structure: struct });
  console.log(`${id}: ${status} in ${(processWallMs / 1000).toFixed(1)} s`);
}
writeFileSync(resolve(outDir, "pilot_runs.json"), `${JSON.stringify(runs.map(({ report, ...rest }) => ({ ...rest,
  report_summary: report && { analysis_status: report.analysis_status, elapsed_ms: report.elapsed_ms,
    check_elapsed_ms: report.check_elapsed_ms, query_stats: report.query_stats, counts: report.counts,
    inconclusive_queries: report.inconclusive_queries } })), null, 2)}\n`);
writeReport(runs, structure, structureMs);

// --------------------------------------------------------------- report
function conflictOverlap(run) {
  const cDiff = run.structure.pairs.C_diff;
  const stats = run.report?.query_stats.by_check.action_conflict ?? run.last_by_check?.action_conflict ?? { sat: 0, unsat: 0, unknown: 0 };
  const conflictDone = run.report !== null || (run.last_by_check && run.last_event?.stage !== "action_conflict");
  if (conflictDone && stats.unknown === 0 && stats.sat + stats.unsat === cDiff) return { exact: stats.sat, low: stats.sat, high: stats.sat };
  return { exact: null, low: stats.sat, high: cDiff - stats.unsat };
}

function writeReport(runs, structure, structureMs) {
  const checks = PARAMS.analysis_types;
  const fmt = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
  const L = ["# Dense-overlap scalability — pilot", "",
    "Generated by `node validation/dense_overlap/run_pilot.mjs`. Parameters were frozen in `params.json` before any "
    + "run; environment, git state and source hashes are in `run_manifest.json`.", "",
    `- Query timeout ${PARAMS.pilot.query_timeout_ms} ms; process wall-clock limit ${PARAMS.pilot.wall_clock_limit_ms / 1000} s `
    + "(covers process start, module loading, policy generation, Z3 initialisation and analysis).",
    "- `analyze ms` is measured inside `analyze()` only. `process s` is the wall-clock time of the worker process.",
    "- Means below use **complete** runs only. Other runs are listed with their last recorded stage.", "",
    "## Runs", "",
    "| Run | Status | Process s | analyze ms | Queries (SAT/UNSAT/UNK) | P_all | C_all (ratio) | P_diff | C_diff (ratio) | G_all | G_diff | Diff-action true overlap | Findings |",
    "|---|---|---:|---:|---|---:|---|---:|---|---:|---:|---|---|"];
  const sorted = [...runs].sort((a, b) => a.n - b.n || PARAMS.pilot.densities.indexOf(a.density) - PARAMS.pilot.densities.indexOf(b.density) || a.seed - b.seed);
  for (const run of sorted) {
    const sp = run.structure.pairs;
    const q = run.report?.query_stats ?? run.last_queries;
    const ov = conflictOverlap(run);
    const findings = run.report ? Object.entries(run.report.counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("; ") : "—";
    L.push(`| ${run.id} | ${run.status}${run.status !== "complete" && run.last_event ? ` (last: ${run.last_event.event}/${run.last_event.stage ?? "-"})` : ""} | `
      + `${fmt(run.process_wall_ms / 1000)} | ${fmt(run.report?.elapsed_ms)} | ${q ? `${q.total} (${q.sat}/${q.unsat}/${q.unknown})` : "—"} | `
      + `${sp.P_all} | ${sp.C_all} (${fmt(100 * sp.prefilter_candidate_ratio_all)}%) | ${sp.P_diff} | ${sp.C_diff} (${fmt(100 * sp.prefilter_candidate_ratio_diff)}%) | `
      + `${sp.G_all} | ${sp.G_diff} | ${ov.exact !== null ? `${ov.exact} (exact)` : `${ov.low}–${ov.high} (bounds)`} | ${findings} |`);
  }
  L.push("", "## Time per check (analyze ms, complete runs)", "",
    `| Run | ${checks.join(" | ")} |`, `|---|${checks.map(() => "---:").join("|")}|`);
  for (const run of sorted.filter(r => r.status === "complete")) {
    L.push(`| ${run.id} | ${checks.map(c => fmt(run.report.check_elapsed_ms[c])).join(" | ")} |`);
  }
  L.push("", "## Queries per check (SAT/UNSAT/UNKNOWN)", "", `| Run | ${checks.join(" | ")} |`, `|---|${checks.map(() => "---").join("|")}|`);
  const checkKeys = { action_conflict: ["action_conflict"], shadowing: ["shadowing_reachability", "shadowing_representative"],
    redundancy: ["redundancy_difference", "redundancy_representative"], coverage_gap: ["coverage_gap"],
    exception_leakage: ["exception_leakage"], semantic_divergence: ["semantic_divergence"] };
  for (const run of sorted) {
    const by = run.report?.query_stats.by_check ?? run.last_by_check ?? {};
    L.push(`| ${run.id} | ${checks.map(c => checkKeys[c].map(k => by[k] ? `${by[k].sat}/${by[k].unsat}/${by[k].unknown}` : "—").join(" + ")).join(" | ")} |`);
  }

  // Mean per cell (complete runs only).
  L.push("", "## Cell means (complete runs only)", "", "| n | Density | Complete | analyze ms mean | Queries mean |", "|---:|---|---|---:|---:|");
  for (const n of PARAMS.pilot.sizes) for (const density of PARAMS.pilot.densities) {
    const cell = runs.filter(r => r.n === n && r.density === density);
    const done = cell.filter(r => r.status === "complete");
    const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    L.push(`| ${n} | ${density} | ${done.length}/${cell.length} | ${fmt(mean(done.map(r => r.report.elapsed_ms)))} | ${fmt(mean(done.map(r => r.report.query_stats.total)), 0)} |`);
  }

  // Structural counts for all sizes.
  L.push("", "## Structural counts (solver-free, seeds 1–2, mean)", "",
    `Computed in ${structureMs} ms for ${structure.length} policies; excluded from all analysis times. `
    + "Every rule matches its anchor effectively (concrete evaluator) and every shared-anchor pair passes the prefilter.", "",
    "| n | Density | P_all | C_all ratio | P_diff | C_diff | G_all | G_diff | Shadow Q / cand. sum | Redund. Q / cand. sum | Leakage Q |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---|---|---:|");
  const groups = new Map();
  for (const r of structure) {
    const key = `${r.n}|${r.density}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, group] of groups) {
    const [n, density] = key.split("|");
    const avg = f => group.reduce((s, r) => s + f(r), 0) / group.length;
    L.push(`| ${n} | ${density} | ${avg(r => r.pairs.P_all).toFixed(0)} | ${(100 * avg(r => r.pairs.prefilter_candidate_ratio_all)).toFixed(1)}% | `
      + `${avg(r => r.pairs.P_diff).toFixed(0)} | ${avg(r => r.pairs.C_diff).toFixed(0)} | ${avg(r => r.pairs.G_all).toFixed(0)} | ${avg(r => r.pairs.G_diff).toFixed(0)} | `
      + `${avg(r => r.candidates.shadowing_reachability_queries).toFixed(0)} / ${avg(r => r.candidates.shadowing_candidate_sum).toFixed(0)} | `
      + `${avg(r => r.candidates.redundancy_difference_queries).toFixed(0)} / ${avg(r => r.candidates.redundancy_candidate_sum).toFixed(0)} | `
      + `${avg(r => r.candidates.exception_leakage_queries).toFixed(0)} |`);
  }
  writeFileSync(resolve(outDir, "pilot_report.md"), `${L.join("\n")}\n`);
  const csvHead = ["id", "n", "density", "seed", "status", "process_wall_ms", "analyze_ms", ...checks.map(c => `ms_${c}`),
    "queries_total", "sat", "unsat", "unknown", "P_all", "P_diff", "C_all", "C_diff", "G_all", "G_diff", "conflict_overlap_low", "conflict_overlap_high"];
  const csv = [csvHead.join(",")];
  for (const run of sorted) {
    const q = run.report?.query_stats ?? run.last_queries ?? {};
    const sp = run.structure.pairs;
    const ov = conflictOverlap(run);
    csv.push([run.id, run.n, run.density, run.seed, run.status, run.process_wall_ms, run.report?.elapsed_ms ?? "",
      ...checks.map(c => run.report?.check_elapsed_ms[c] ?? ""), q.total ?? "", q.sat ?? "", q.unsat ?? "", q.unknown ?? "",
      sp.P_all, sp.P_diff, sp.C_all, sp.C_diff, sp.G_all, sp.G_diff, ov.low, ov.high].join(","));
  }
  writeFileSync(resolve(outDir, "pilot_runs.csv"), `${csv.join("\n")}\n`);
}
