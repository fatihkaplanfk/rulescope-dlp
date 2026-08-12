import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "../src/analyzer.js";
import { clauseMatches, evaluatePolicy } from "../src/evaluator.js";
import { ACTION_SEVERITY } from "../src/schema.js";
import { buildSpediaPolicies } from "./spedia-policy.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
const resultDir = resolve(projectRoot, "results");
const dataset = resolve(option("--dataset") ?? resolve(projectRoot, "data", "raw", "logs_SPEDIA_annotated_en.csv"));
const temporary = await mkdtemp(resolve(tmpdir(), "policylint-spedia-"));
const normalized = resolve(temporary, "spedia.jsonl");
const profilePath = resolve(resultDir, "spedia_dataset_profile.csv");

await mkdir(resultDir, { recursive: true });

try {
  const preparation = spawnSync(
    "python",
    [resolve(currentDir, "prepare_spedia.py"), "--input", dataset, "--output", normalized, "--profile", profilePath],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (preparation.status !== 0) {
    throw new Error(`SPEDIA preparation failed:\n${preparation.stderr || preparation.stdout}`);
  }
  const datasetSummary = JSON.parse(preparation.stdout.trim());
  const events = await readJsonLines(normalized);
  const variants = buildSpediaPolicies();
  const api = await z3Solver.init();
  const formalReports = [];
  const summaryRows = [];
  const channelRows = [];

  try {
    for (const variant of variants) {
      const analyzer = new DlpAnalyzer(api.Context, variant.policy, `spedia_${variant.id}`);
      const report = await analyzer.analyze();
      formalReports.push({
        variant: variant.id,
        mutations: variant.mutations,
        counts: report.counts,
        finding_count: report.finding_count,
        elapsed_ms: report.elapsed_ms,
        findings: report.findings
      });

      for (const semantics of ["first_match", "most_restrictive"]) {
        const scored = scoreEvents(variant.policy, events, semantics);
        summaryRows.push({ variant: variant.id, mutations: variant.mutations.join("+"), semantics, ...scored.summary });
        for (const [channel, channelMetrics] of Object.entries(scored.channels)) {
          channelRows.push({ variant: variant.id, semantics, channel, ...channelMetrics });
        }
      }
    }
  } finally {
    api.em.PThread?.terminateAllThreads?.();
  }

  await writeFile(resolve(resultDir, "spedia_replay_summary.csv"), toCsv(summaryRows), "utf8");
  await writeFile(resolve(resultDir, "spedia_replay_channels.csv"), toCsv(channelRows), "utf8");
  await writeFile(
    resolve(resultDir, "spedia_formal_findings.json"),
    `${JSON.stringify({ dataset: datasetSummary, variants: formalReports }, null, 2)}\n`,
    "utf8"
  );

  console.log(`SPEDIA source rows: ${datasetSummary.source_rows}`);
  console.log(`DLP-relevant replay rows: ${datasetSummary.normalized_rows}`);
  for (const row of summaryRows.filter(item => item.semantics === "first_match")) {
    console.log(
      `${row.variant.padEnd(17)} coverage=${Number(row.observed_requirement_coverage).toFixed(3)} ` +
      `exposed=${row.exposed_events} exposed-anomaly=${row.exposed_anomaly}`
    );
  }
  console.log(`Wrote SPEDIA results to ${resultDir}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function scoreEvents(policy, events, semantics) {
  const total = emptyMetrics();
  const channels = {};

  for (const event of events) {
    const metrics = channels[event.channel] ??= emptyMetrics();
    updateBasic(total, event);
    updateBasic(metrics, event);

    const requirements = policy.requirements.filter(requirement => clauseMatches(requirement.conditions, event));
    if (requirements.length === 0) continue;
    const requiredSeverity = Math.max(...requirements.map(requirement => ACTION_SEVERITY[requirement.minimum_action]));
    const decision = evaluatePolicy(policy, event, semantics);
    const satisfied = ACTION_SEVERITY[decision.action] >= requiredSeverity;
    updateProtected(total, event, satisfied);
    updateProtected(metrics, event, satisfied);
  }

  return {
    summary: finalizeMetrics(total),
    channels: Object.fromEntries(Object.entries(channels).map(([key, value]) => [key, finalizeMetrics(value)]))
  };
}

function emptyMetrics() {
  return {
    total_events: 0,
    anomaly_events: 0,
    non_anomaly_events: 0,
    protected_events: 0,
    protected_anomaly: 0,
    protected_non_anomaly: 0,
    satisfied_required_events: 0,
    exposed_events: 0,
    exposed_anomaly: 0,
    exposed_non_anomaly: 0
  };
}

function updateBasic(metrics, event) {
  metrics.total_events += 1;
  if (event.anomaly === 1) metrics.anomaly_events += 1;
  else metrics.non_anomaly_events += 1;
}

function updateProtected(metrics, event, satisfied) {
  metrics.protected_events += 1;
  if (event.anomaly === 1) metrics.protected_anomaly += 1;
  else metrics.protected_non_anomaly += 1;
  if (satisfied) {
    metrics.satisfied_required_events += 1;
    return;
  }
  metrics.exposed_events += 1;
  if (event.anomaly === 1) metrics.exposed_anomaly += 1;
  else metrics.exposed_non_anomaly += 1;
}

function finalizeMetrics(metrics) {
  return {
    ...metrics,
    observed_requirement_coverage: ratio(metrics.satisfied_required_events, metrics.protected_events),
    anomaly_exposure_rate: ratio(metrics.exposed_anomaly, metrics.protected_anomaly),
    non_anomaly_exposure_rate: ratio(metrics.exposed_non_anomaly, metrics.protected_non_anomaly)
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function readJsonLines(path) {
  const events = [];
  const input = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) events.push(JSON.parse(line));
  }
  return events;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toCsv(records) {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]);
  const lines = [headers.join(",")];
  for (const record of records) {
    lines.push(headers.map(header => csvValue(record[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
