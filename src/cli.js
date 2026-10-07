#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import z3Solver from "z3-solver";
import { DlpAnalyzer } from "./analyzer.js";
import { formatTextReport } from "./report.js";
import { loadAndValidatePolicy } from "./schema.js";

async function main() {
  const { init } = z3Solver;
  const [command, input, ...flags] = process.argv.slice(2);
  if (command !== "analyze" || !input) {
    console.error("Usage: rulescope-dlp analyze <policy.json> [--format text|json] [--semantics first_match|most_restrictive]");
    process.exitCode = 2;
    return;
  }

  const option = name => {
    const index = flags.indexOf(name);
    return index >= 0 ? flags[index + 1] : undefined;
  };
  const format = option("--format") ?? "text";
  const semantics = option("--semantics");
  const policyPath = resolve(input);
  const raw = JSON.parse(await readFile(policyPath, "utf8"));
  const policy = loadAndValidatePolicy(raw);
  const api = await init();
  try {
    const analyzer = new DlpAnalyzer(api.Context, policy, "policylint_cli");
    const report = await analyzer.analyze({ semantics });
    console.log(format === "json" ? JSON.stringify(report, null, 2) : formatTextReport(report));
  } finally {
    api.em.PThread?.terminateAllThreads?.();
  }
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
