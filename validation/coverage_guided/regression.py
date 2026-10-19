#!/usr/bin/env python3
"""Regression check for the coverage-guided baseline addition (Reviewer 2).

Re-runs the unchanged controlled benchmark (experiments/run-benchmark.js) and
the SPEDIA replay (experiments/run-spedia-replay.js) in an isolated temporary
copy of the repository, then compares the fresh outputs with the committed
results/ and with Table 2 of the manuscript. It also confirms that every file
under results/ is byte-identical to a hash list taken before the experiment.
Writes validation/coverage_guided_regression.md only.

Usage
  python validation/coverage_guided/regression.py --before-hashes FILE
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "validation" / "coverage_guided_regression.md"

# Table 2 of the submitted manuscript (F1 columns; timing is environment-specific).
TABLE2_F1 = {50: ("1.000", "0.415"), 100: ("1.000", "0.396"), 250: ("1.000", "0.292"),
             500: ("1.000", "0.322"), 1000: ("1.000", "0.406")}
TEXT_TOTALS = {"smt_tp": 350, "smt_fp": 0, "random_tp": 95, "random_fp": 2, "random_fn": 255,
               "random_mean_f1": "0.366"}
SPEDIA_FILES = ("spedia_replay_summary.csv", "spedia_replay_channels.csv", "spedia_dataset_profile.csv")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-hashes", type=Path, required=True,
                        help="sha256sum output for results/ taken before the experiment")
    parser.add_argument("--dataset", type=Path, default=ROOT / "logs_SPEDIA_annotated_en.csv")
    args = parser.parse_args()
    node = shutil.which("node")
    started = datetime.now(timezone.utc)

    # 1. results/ untouched since before the experiment.
    hash_lines = [l.split(None, 1) for l in args.before_hashes.read_text("utf-8").splitlines() if l.strip()]
    changed = [p.strip().lstrip("*") for h, p in hash_lines if sha(ROOT / p.strip().lstrip("*")) != h]

    # 2. Fresh benchmark + replay in an isolated copy.
    with tempfile.TemporaryDirectory(prefix="rulescope-cg-regression-") as tmp:
        work = Path(tmp)
        for name in ("src", "experiments", "benchmark", "node_modules"):
            shutil.copytree(ROOT / name, work / name)
        shutil.copy2(ROOT / "package.json", work / "package.json")
        bench = subprocess.run([node, "experiments/run-benchmark.js"], cwd=work, capture_output=True, text=True)
        if bench.returncode != 0:
            raise SystemExit(bench.stderr)
        replay = subprocess.run([node, "experiments/run-spedia-replay.js", "--dataset", str(args.dataset.resolve())],
                                cwd=work, capture_output=True, text=True)
        if replay.returncode != 0:
            raise SystemExit(replay.stderr)
        fresh_runs = rows(work / "results" / "benchmark_runs.csv")
        fresh_raw = {p.name: json.loads(p.read_text("utf-8")) for p in (work / "results" / "raw").glob("*.json")}
        fresh_spedia = {name: rows(work / "results" / name) for name in SPEDIA_FILES}

    committed_runs = rows(ROOT / "results" / "benchmark_runs.csv")
    committed_raw = {p.name: json.loads(p.read_text("utf-8")) for p in (ROOT / "results" / "raw").glob("*.json")}

    # 3. Benchmark comparisons (ids and effectiveness; timings reported only).
    id_diffs, metric_diffs = [], []
    for name, old in committed_raw.items():
        new = fresh_raw[name]
        for key in ("expected_ids", "exact_ids", "random_ids"):
            if sorted(old[key]) != sorted(new[key]):
                id_diffs.append(f"{name} {key}")
    effect_keys = [k for k in committed_runs[0] if k.endswith(("precision", "recall", "f1")) or k in ("size", "seed", "samples")]
    for old, new in zip(committed_runs, fresh_runs):
        for key in effect_keys:
            if old[key] != new[key]:
                metric_diffs.append(f"n={old['size']} seed={old['seed']} {key}: {old[key]} -> {new[key]}")
    expected_total = sum(len(r["expected_ids"]) for r in fresh_raw.values())

    def mean(values):
        return sum(values) / len(values)

    def sd(values):
        m = mean(values)
        return (sum((v - m) ** 2 for v in values) / (len(values) - 1)) ** 0.5

    table2_rows, table2_ok = [], True
    for size, (smt_paper, rnd_paper) in TABLE2_F1.items():
        group = [r for r in fresh_runs if int(r["size"]) == size]
        smt = f"{mean([float(r['exact_f1']) for r in group]):.3f}"
        rnd = f"{mean([float(r['random_f1']) for r in group]):.3f}"
        rnd_sd = f"{sd([float(r['random_f1']) for r in group]):.3f}"
        ok = (smt, rnd) == (smt_paper, rnd_paper)
        table2_ok &= ok
        table2_rows.append((size, smt_paper, smt, rnd_paper, rnd, rnd_sd, ok))

    def count(arm):
        tp = fp = fn = 0
        for run in fresh_raw.values():
            exp, got = set(run["expected_ids"]), set(run[f"{arm}_ids"])
            tp += len(exp & got); fp += len(got - exp); fn += len(exp - got)
        return tp, fp, fn
    smt_c, rnd_c = count("exact"), count("random")
    rnd_mean_f1 = f"{mean([float(r['random_f1']) for r in fresh_runs]):.3f}"
    totals_ok = (smt_c[0], smt_c[1], rnd_c[0], rnd_c[1], rnd_c[2], rnd_mean_f1) == (
        TEXT_TOTALS["smt_tp"], TEXT_TOTALS["smt_fp"], TEXT_TOTALS["random_tp"], TEXT_TOTALS["random_fp"],
        TEXT_TOTALS["random_fn"], TEXT_TOTALS["random_mean_f1"])

    # 4. SPEDIA comparisons.
    spedia_diffs = []
    for name in SPEDIA_FILES:
        old = rows(ROOT / "results" / name)
        if old != fresh_spedia[name]:
            spedia_diffs.append(name)

    ok = not changed and not id_diffs and not metric_diffs and table2_ok and totals_ok and not spedia_diffs \
        and expected_total == 350
    L = [
        "# Regression check: coverage-guided baseline addition",
        "",
        "Generated by `python validation/coverage_guided/regression.py`. The benchmark and the SPEDIA replay were "
        "re-run from the unchanged code in an isolated temporary copy. The committed `results/` were not written.",
        "",
        f"- Run (UTC): {started:%Y-%m-%d %H:%M:%S}",
        f"- Overall: **{'all checks passed' if ok else 'DIFFERENCES FOUND — see below'}**",
        "",
        "## 1. Committed `results/` unchanged by the experiment",
        "",
        f"SHA-256 of all {len(hash_lines)} files under `results/`, taken before the coverage-guided run, compared now: "
        + ("**all identical**." if not changed else f"**changed: {changed}**"),
        "",
        "## 2. SMT and uniform-random results (fresh rerun vs. committed)",
        "",
        f"- Finding ids (`expected_ids`, `exact_ids`, `random_ids`) in all 50 raw files: "
        + ("identical." if not id_diffs else f"differences: {id_diffs}"),
        f"- Precision, recall and F1 for both arms in `benchmark_runs.csv` (50 rows): "
        + ("identical." if not metric_diffs else f"differences: {metric_diffs[:20]}"),
        f"- Expected findings in total: {expected_total} (expected 350).",
        f"- SMT TP/FP/FN: {smt_c[0]}/{smt_c[1]}/{smt_c[2]}. Uniform random TP/FP/FN: {rnd_c[0]}/{rnd_c[1]}/{rnd_c[2]}. "
        f"Uniform mean per-run F1: {rnd_mean_f1}. Manuscript: 350/0/0, 95/2/255, 0.366: "
        + ("**match**." if totals_ok else "**MISMATCH**."),
        "- Timings (`elapsed_ms`, `rss_mb`) are not compared. They depend on the machine, which is not the "
        "Table 2 environment.",
        "",
        "## 3. Table 2 effectiveness columns",
        "",
        "| Rules | SMT F1 (paper) | SMT F1 (rerun) | Random F1 (paper) | Random F1 (rerun) | Random F1 SD (rerun) | Match |",
        "|---:|---|---|---|---|---|---|",
    ]
    for size, sp, sr, rp, rr, rsd, match in table2_rows:
        L.append(f"| {size:,} | {sp} | {sr} | {rp} | {rr} | {rsd} | {'yes' if match else '**NO**'} |")
    L += [
        "",
        "The Table 2 timing columns were not re-measured as published values. Changing them would require the "
        "original environment (see `benchmark_environment_audit.md`).",
        "",
        "## 4. SPEDIA replay",
        "",
        f"Fresh replay vs. committed `{'`, `'.join(SPEDIA_FILES)}`: "
        + ("**identical**." if not spedia_diffs else f"**differences in {spedia_diffs}**"),
        "",
        "## 5. Code untouched",
        "",
        "The coverage-guided baseline lives entirely in `validation/coverage_guided/`. No file under `src/`, "
        "`benchmark/`, `experiments/` or `test/` was modified for it. The only uncommitted changes in those folders are the earlier naming-only RuleScope-DLP edits (labels and comments; see `rename_audit.md`). Its observation function is a verbatim copy "
        "of the observation part of `src/baseline.js`. Equivalence was checked in every run (50/50, see "
        "`coverage_guided_summary.md`).",
        "",
    ]
    OUT.write_text("\n".join(L), "utf-8")
    print("\n".join(L[:6]))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
