import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
const resultDir = resolve(projectRoot, "results");
const sizes = parseList(option("--sizes") ?? "50,100,250,500,1000");
const seeds = parseList(option("--seeds") ?? "1,2,3,4,5,6,7,8,9,10");
const samples = Number(option("--samples") ?? 10000);
const runs = [];

await mkdir(resolve(resultDir, "raw"), { recursive: true });

for (const size of sizes) {
  for (const seed of seeds) {
    const child = spawnSync(
      process.execPath,
      [resolve(currentDir, "benchmark-worker.js"), String(size), String(seed), String(samples)],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    if (child.status !== 0) {
      throw new Error(`Benchmark failed for n=${size}, seed=${seed}:\n${child.stderr}`);
    }
    const run = JSON.parse(child.stdout);
    runs.push(run);
    await writeFile(
      resolve(resultDir, "raw", `run_n${size}_seed${seed}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8"
    );
    console.log(
      `n=${size} seed=${seed} exact=${run.exact.elapsed_ms.toFixed(1)}ms ` +
      `random=${run.random.elapsed_ms.toFixed(1)}ms exactF1=${run.exact.f1.toFixed(3)} ` +
      `randomF1=${run.random.f1.toFixed(3)}`
    );
  }
}

const rows = runs.map(run => ({
  size: run.size,
  seed: run.seed,
  samples: run.samples,
  exact_elapsed_ms: run.exact.elapsed_ms,
  exact_rss_mb: run.exact.rss_mb,
  exact_precision: run.exact.precision,
  exact_recall: run.exact.recall,
  exact_f1: run.exact.f1,
  random_elapsed_ms: run.random.elapsed_ms,
  random_rss_mb: run.random.rss_mb,
  random_precision: run.random.precision,
  random_recall: run.random.recall,
  random_f1: run.random.f1
}));
const summary = summarize(rows, sizes);

await writeFile(resolve(resultDir, "benchmark_runs.csv"), toCsv(rows), "utf8");
await writeFile(resolve(resultDir, "benchmark_summary.csv"), toCsv(summary), "utf8");
await writeFile(
  resolve(resultDir, "representative_findings.json"),
  `${JSON.stringify(runs.find(run => run.size === sizes[0] && run.seed === seeds[0]).representative_findings, null, 2)}\n`,
  "utf8"
);

console.log(`Wrote ${runs.length} runs to ${resultDir}`);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseList(value) {
  return value.split(",").map(item => Number(item.trim())).filter(Number.isFinite);
}

function summarize(rows, requestedSizes) {
  const output = [];
  for (const size of requestedSizes) {
    const group = rows.filter(row => row.size === size);
    const record = { size, runs: group.length };
    for (const metric of [
      "exact_elapsed_ms", "exact_rss_mb", "exact_precision", "exact_recall", "exact_f1",
      "random_elapsed_ms", "random_rss_mb", "random_precision", "random_recall", "random_f1"
    ]) {
      const values = group.map(row => row[metric]);
      record[`${metric}_mean`] = mean(values);
      record[`${metric}_sd`] = standardDeviation(values);
    }
    output.push(record);
  }
  return output;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function toCsv(records) {
  const headers = Object.keys(records[0]);
  const lines = [headers.join(",")];
  for (const record of records) {
    lines.push(headers.map(header => csvValue(record[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvValue(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
