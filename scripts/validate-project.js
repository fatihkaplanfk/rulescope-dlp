import { access, readFile } from "node:fs/promises";

const required = [
  "README.md",
  "LICENSE",
  "package.json",
  "src/analyzer.js",
  "src/cli.js",
  "examples/sample-policy.json",
  "experiments/fetch_spedia.py",
  "experiments/prepare_spedia.py",
  "experiments/run-spedia-replay.js",
  "results/spedia_dataset_profile.csv",
  "results/spedia_replay_summary.csv",
  "results/spedia_formal_findings.json"
];

for (const path of required) await access(path);
JSON.parse(await readFile("package.json", "utf8"));
JSON.parse(await readFile("examples/sample-policy.json", "utf8"));
console.log("Project structure and JSON files are valid.");
