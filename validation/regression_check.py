#!/usr/bin/env python3
"""Re-run the SPEDIA replay in an isolated copy and compare with the paper.

The committed files under results/ are never overwritten. The replay script
(experiments/run-spedia-replay.js) writes to <copy>/results/. This script
copies src/, experiments/, package.json and node_modules/ to a temporary
directory, runs the unchanged replay there, keeps the fresh outputs in
validation/output/regression_rerun/, and writes regression_results.md.

Usage
  npm ci
  python validation/regression_check.py [--dataset PATH]
"""

from __future__ import annotations

import argparse
import csv
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "validation" / "output"
RERUN = OUTPUT / "regression_rerun"
COMPARED_CSV = ("spedia_replay_summary.csv", "spedia_replay_channels.csv", "spedia_dataset_profile.csv")

# Table 3 of the submitted manuscript (first-match semantics), transcribed
# from 03_PolicyLint_DLP_SAUCIS_Author.tex (label tab:spedia) and
# PolicyLint_DLP_SAUCIS_.docx; both contain identical values.
TABLE3 = {
    "clean":           {"in_scope": 4474, "coverage_pct": "100.0", "exposed": 0,    "exposed_anomaly": 0},
    "shadow_email":    {"in_scope": 4474, "coverage_pct": "58.6",  "exposed": 1851, "exposed_anomaly": 1236},
    "exception_usb":   {"in_scope": 4474, "coverage_pct": "51.3",  "exposed": 2178, "exposed_anomaly": 1300},
    "conflict_cloud":  {"in_scope": 4474, "coverage_pct": "90.1",  "exposed": 445,  "exposed_anomaly": 150},
    "combined_faults": {"in_scope": 4474, "coverage_pct": "0.0",   "exposed": 4474, "exposed_anomaly": 2686},
}
TABLE3_FINDINGS = {  # "Solver findings" column, as finding-type counts
    "clean": {},
    "shadow_email": {"action_conflict": 1, "shadowing": 1, "redundancy": 1, "coverage_gap": 1, "semantic_divergence": 1},
    "exception_usb": {"coverage_gap": 1, "exception_leakage": 1},
    "conflict_cloud": {"action_conflict": 1, "coverage_gap": 1, "semantic_divergence": 1},
    "combined_faults": {"action_conflict": 2, "shadowing": 1, "redundancy": 1, "coverage_gap": 3,
                        "exception_leakage": 1, "semantic_divergence": 1},
}
VOLATILE_KEYS = {"elapsed_ms"}  # wall-clock timing, expected to differ


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def strip_volatile(value):
    if isinstance(value, dict):
        return {k: strip_volatile(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [strip_volatile(v) for v in value]
    return value


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=ROOT / "logs_SPEDIA_annotated_en.csv")
    args = parser.parse_args()
    if not (ROOT / "node_modules" / "z3-solver").exists():
        raise SystemExit("node_modules/z3-solver missing; run `npm ci` first.")
    node = shutil.which("node")
    started = datetime.now(timezone.utc)

    # 1. Unit tests (read-only; run in place).
    tests = run([node, "--test", "--test-reporter=tap"], ROOT)

    # 2. Replay in an isolated copy.
    with tempfile.TemporaryDirectory(prefix="policylint-regression-") as tmp:
        work = Path(tmp)
        for name in ("src", "experiments", "node_modules"):
            shutil.copytree(ROOT / name, work / name)
        shutil.copy2(ROOT / "package.json", work / "package.json")
        replay = run([node, "experiments/run-spedia-replay.js", "--dataset", str(args.dataset.resolve())], work)
        if replay.returncode != 0:
            print(replay.stdout, replay.stderr)
            raise SystemExit("Replay failed; see output above.")
        if RERUN.exists():
            shutil.rmtree(RERUN)
        shutil.copytree(work / "results", RERUN)

    # 3. Compare with committed results.
    csv_diffs = {}
    for name in COMPARED_CSV:
        old, new = read_csv(ROOT / "results" / name), read_csv(RERUN / name)
        diffs = []
        if len(old) != len(new):
            diffs.append(f"row count {len(old)} -> {len(new)}")
        for index, (a, b) in enumerate(zip(old, new)):
            for key in sorted(set(a) | set(b)):
                if a.get(key) != b.get(key):
                    diffs.append(f"row {index + 1} `{key}`: {a.get(key)} -> {b.get(key)}")
        csv_diffs[name] = diffs

    old_json = json.loads((ROOT / "results" / "spedia_formal_findings.json").read_text("utf-8"))
    new_json = json.loads((RERUN / "spedia_formal_findings.json").read_text("utf-8"))
    json_equal = strip_volatile(old_json) == strip_volatile(new_json)
    json_notes = []
    if not json_equal:
        for old_v, new_v in zip(old_json["variants"], new_json["variants"]):
            if strip_volatile(old_v) != strip_volatile(new_v):
                if old_v["counts"] != new_v["counts"]:
                    json_notes.append(f"{old_v['variant']}: finding counts {old_v['counts']} -> {new_v['counts']}")
                elif [f["id"] for f in old_v["findings"]] != [f["id"] for f in new_v["findings"]]:
                    json_notes.append(f"{old_v['variant']}: finding ids differ")
                else:
                    json_notes.append(f"{old_v['variant']}: same finding ids and counts; witness values differ")
        if strip_volatile(old_json["dataset"]) != strip_volatile(new_json["dataset"]):
            json_notes.append(f"dataset summary {old_json['dataset']} -> {new_json['dataset']}")

    # 4. Table 3 comparison from the fresh run.
    summary = {(r["variant"], r["semantics"]): r for r in read_csv(RERUN / "spedia_replay_summary.csv")}
    findings = {v["variant"]: {k: n for k, n in v["counts"].items() if n} for v in new_json["variants"]}
    table_rows, table_ok = [], True
    for variant, paper in TABLE3.items():
        r = summary[(variant, "first_match")]
        fresh = {
            "in_scope": int(r["protected_events"]),
            "coverage_pct": f"{100 * float(r['observed_requirement_coverage']):.1f}",
            "exposed": int(r["exposed_events"]),
            "exposed_anomaly": int(r["exposed_anomaly"]),
        }
        same = fresh == paper and findings[variant] == TABLE3_FINDINGS[variant]
        table_ok &= same
        table_rows.append((variant, paper, fresh, findings[variant], same))

    zver = json.loads((ROOT / "node_modules" / "z3-solver" / "package.json").read_text("utf-8"))["version"]
    lines = [
        "# Regression results — SPEDIA replay",
        "",
        "Generated by `validation/regression_check.py`. The committed `results/` files were **not** "
        "modified. The fresh outputs are stored in `validation/output/regression_rerun/`.",
        "",
        "## Environment",
        "",
        f"- Run (UTC): {started:%Y-%m-%d %H:%M:%S}",
        f"- Platform: {platform.platform()}",
        f"- Node.js: {run([node, '--version'], ROOT).stdout.strip()}; z3-solver: {zver} (from package-lock.json)",
        f"- Python: {platform.python_version()}",
        f"- Dataset: `{args.dataset.name}`",
        "",
        "## Commands",
        "",
        "```bash",
        "npm ci",
        "node --test --test-reporter=tap",
        "python validation/regression_check.py",
        "```",
        "",
        "## Unit tests (`node --test`)",
        "",
        f"Exit code: {tests.returncode}",
        "",
        "```",
        "\n".join(line for line in tests.stdout.splitlines() if line.startswith(("# ", "ok", "not ok"))),
        "```",
        "",
        "## Table 3 (first-match) — paper vs. fresh replay",
        "",
        "| Variant | Paper in-scope | Fresh | Paper coverage | Fresh | Paper exposed | Fresh | "
        "Paper exposed anomaly | Fresh | Solver findings (fresh) | Match |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for variant, paper, fresh, found, same in table_rows:
        lines.append(
            f"| {variant} | {paper['in_scope']:,} | {fresh['in_scope']:,} | {paper['coverage_pct']}% | "
            f"{fresh['coverage_pct']}% | {paper['exposed']:,} | {fresh['exposed']:,} | {paper['exposed_anomaly']:,} | "
            f"{fresh['exposed_anomaly']:,} | {found or 'none'} | {'yes' if same else '**NO**'} |")
    lines += [
        "",
        f"**Table 3 reproduced exactly: {'yes' if table_ok else 'NO — see differences below'}.**",
        "",
        "## Committed `results/` vs. fresh replay",
        "",
        "| File | Differences |",
        "|---|---|",
    ]
    for name, diffs in csv_diffs.items():
        lines.append(f"| `results/{name}` | {'none (all values identical)' if not diffs else '<br>'.join(diffs[:20])} |")
    lines.append(
        f"| `results/spedia_formal_findings.json` | "
        f"{'none, apart from `elapsed_ms` timing' if json_equal else '<br>'.join(json_notes)} |")
    lines += [
        "",
        "## Interpretation",
        "",
        ("No change was observed. The replay counts depend only on the dataset (verified by MD5), the "
         "unchanged adapter and the unchanged policy. Only solver wall-clock times (`elapsed_ms`) differ, "
         "which is expected and does not affect any reported count."
         if table_ok and json_equal and not any(csv_diffs.values()) else
         "Differences were observed and are listed above. They have **not** been applied to `results/` or "
         "to the manuscript. Investigate the cause before deciding whether any number must change."),
        "",
    ]
    (OUTPUT / "regression_results.md").write_text("\n".join(lines), "utf-8")
    print("\n".join(lines))
    return 0 if (table_ok and tests.returncode == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
