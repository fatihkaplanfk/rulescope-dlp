#!/usr/bin/env python3
"""Regression for the formal-model fixes (SAUCIS Reviewer 2).

Writes only to validation/output/formal_model_fixes/. results/ is never written:
the benchmark and the SPEDIA replay run in isolated temporary copies.

Steps
  1. SHA-256 of every file under results/ before and after the run.
  2. Query census with the current code (query_stats.mjs).
  3. Benchmark + SPEDIA replay with the current code in an isolated copy;
     finding ids, effectiveness metrics and Table 3 compared with results/.
  4. The same benchmark with the previous code (git HEAD) in another isolated
     copy, on the same machine, to see whether the code change affects runtime.
     The published runtimes are not overwritten.

Usage: python validation/formal_model_fixes/regression.py
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import platform
import shutil
import statistics
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "validation" / "output" / "formal_model_fixes"
DATASET = ROOT / "logs_SPEDIA_annotated_en.csv"
SIZES = [50, 100, 250, 500, 1000]
TABLE3 = {"clean": (4474, "100.0", 0, 0), "shadow_email": (4474, "58.6", 1851, 1236),
          "exception_usb": (4474, "51.3", 2178, 1300), "conflict_cloud": (4474, "90.1", 445, 150),
          "combined_faults": (4474, "0.0", 4474, 2686)}
SPEDIA_CSV = ("spedia_replay_summary.csv", "spedia_replay_channels.csv", "spedia_dataset_profile.csv")


def hashes(folder: Path) -> dict[str, str]:
    return {str(p.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def run(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(map(str, cmd))} failed:\n{result.stderr[-4000:]}")
    return result


def isolated_copy(work: Path, source: str) -> None:
    """source = 'current' (working tree) or 'HEAD' (last commit)."""
    names = ("src", "experiments", "benchmark")
    if source == "current":
        for name in names:
            shutil.copytree(ROOT / name, work / name)
        shutil.copy2(ROOT / "package.json", work / "package.json")
    else:
        archive = subprocess.run(["git", "archive", "--format=tar", "HEAD", *names, "package.json"],
                                 cwd=ROOT, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(work, filter="data")
    shutil.copytree(ROOT / "node_modules", work / "node_modules")


def benchmark(work: Path) -> tuple[list[dict], dict[str, dict]]:
    run(["node", "experiments/run-benchmark.js"], work)
    raw = {p.name: json.loads(p.read_text("utf-8")) for p in (work / "results" / "raw").glob("*.json")}
    return rows(work / "results" / "benchmark_runs.csv"), raw


def mean_sd(values):
    return statistics.mean(values), statistics.stdev(values)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node")
    started = datetime.now(timezone.utc)
    before = hashes(ROOT / "results")

    # 2. query census
    census_path = OUT / "query_census.json"
    census_stdout = run([node, "validation/formal_model_fixes/query_stats.mjs", str(census_path)], ROOT).stdout
    census = json.loads(census_path.read_text("utf-8"))

    committed_runs = rows(ROOT / "results" / "benchmark_runs.csv")
    committed_raw = {p.name: json.loads(p.read_text("utf-8")) for p in (ROOT / "results" / "raw").glob("*.json")}
    committed_formal = json.loads((ROOT / "results" / "spedia_formal_findings.json").read_text("utf-8"))

    with tempfile.TemporaryDirectory(prefix="rulescope-formal-") as tmp:
        tmp = Path(tmp)
        old, new = tmp / "old", tmp / "new"
        isolated_copy(old, "HEAD")
        isolated_copy(new, "current")
        # 4. previous code first, then current code, same machine, sequential.
        old_runs, old_raw = benchmark(old)
        new_runs, new_raw = benchmark(new)
        run([node, "experiments/run-spedia-replay.js", "--dataset", str(DATASET)], new)
        new_spedia = {name: rows(new / "results" / name) for name in SPEDIA_CSV}
        new_formal = json.loads((new / "results" / "spedia_formal_findings.json").read_text("utf-8"))
        for label, folder in (("previous_code_benchmark", old / "results"), ("current_code_run", new / "results")):
            target = OUT / label
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(folder, target)

    after = hashes(ROOT / "results")
    results_unchanged = before == after

    # 3a. benchmark ids and metrics, current code vs committed
    id_diffs, metric_diffs = [], []
    for name, old_run in committed_raw.items():
        fresh = new_raw[name]
        for key in ("expected_ids", "exact_ids", "random_ids"):
            if sorted(old_run[key]) != sorted(fresh[key]):
                id_diffs.append(f"{name}:{key}")
    effect = [k for k in committed_runs[0] if k.endswith(("precision", "recall", "f1"))]
    for a, b in zip(committed_runs, new_runs):
        for k in effect:
            if a[k] != b[k]:
                metric_diffs.append(f"n={a['size']} seed={a['seed']} {k}: {a[k]} -> {b[k]}")
    expected_total = sum(len(r["expected_ids"]) for r in new_raw.values())
    smt_tp = sum(len(set(r["exact_ids"]) & set(r["expected_ids"])) for r in new_raw.values())
    smt_fp = sum(len(set(r["exact_ids"]) - set(r["expected_ids"])) for r in new_raw.values())

    # 3b. SPEDIA
    spedia_csv_diffs = [n for n in SPEDIA_CSV if rows(ROOT / "results" / n) != new_spedia[n]]
    summary = {(r["variant"], r["semantics"]): r for r in new_spedia["spedia_replay_summary.csv"]}
    table3_rows, table3_ok = [], True
    for variant, (scope, cov, exposed, anomaly) in TABLE3.items():
        r = summary[(variant, "first_match")]
        fresh = (int(r["protected_events"]), f"{100 * float(r['observed_requirement_coverage']):.1f}",
                 int(r["exposed_events"]), int(r["exposed_anomaly"]))
        table3_ok &= fresh == (scope, cov, exposed, anomaly)
        table3_rows.append((variant, (scope, cov, exposed, anomaly), fresh))
    formal_rows = []
    for old_v, new_v in zip(committed_formal["variants"], new_formal["variants"]):
        old_ids = sorted(f["id"] for f in old_v["findings"])
        new_ids = sorted(f["id"] for f in new_v["findings"])
        old_keys = sorted({k for f in old_v["findings"] for k in f})
        new_keys = sorted({k for f in new_v["findings"] for k in f})
        formal_rows.append({"variant": old_v["variant"], "ids_equal": old_ids == new_ids,
                            "counts_equal": old_v["counts"] == new_v["counts"],
                            "fields_removed": sorted(set(old_keys) - set(new_keys)),
                            "fields_added": sorted(set(new_keys) - set(old_keys))})

    # 4. runtime, previous vs current code
    runtime = []
    for size in SIZES:
        o = [float(r["exact_elapsed_ms"]) for r in old_runs if int(r["size"]) == size]
        n = [float(r["exact_elapsed_ms"]) for r in new_runs if int(r["size"]) == size]
        ro = [float(r["random_elapsed_ms"]) for r in old_runs if int(r["size"]) == size]
        rn = [float(r["random_elapsed_ms"]) for r in new_runs if int(r["size"]) == size]
        runtime.append((size, mean_sd(o), mean_sd(n), mean_sd(ro), mean_sd(rn)))
    old_new_ids_equal = all(sorted(old_raw[k]["exact_ids"]) == sorted(new_raw[k]["exact_ids"]) and
                            sorted(old_raw[k]["random_ids"]) == sorted(new_raw[k]["random_ids"]) for k in old_raw)

    bench = [r for r in census if r["kind"] == "benchmark"]
    totals = {k: sum(r["query_stats"][k] for r in census) for k in ("total", "sat", "unsat", "unknown")}
    ties = [r["label"] for r in census if r["equal_priority_groups"]]

    L = ["# Formal-model fixes — regression", "",
         "Generated by `python validation/formal_model_fixes/regression.py`. Outputs are in "
         "`validation/output/formal_model_fixes/`. The committed `results/` were not written.", "",
         f"- Run (UTC): {started:%Y-%m-%d %H:%M:%S}; machine: {platform.platform()}; "
         f"Node {run([node, '--version'], ROOT).stdout.strip()}", "",
         "## 1. Committed results untouched", "",
         f"SHA-256 of all {len(before)} files under `results/` before and after: "
         + ("**identical**." if results_unchanged else "**CHANGED**."), "",
         "## 2. Controlled benchmark (50 policies), current code vs. committed", "",
         f"- Expected / SMT / random finding ids in all 50 raw runs: "
         + ("**identical**." if not id_diffs else f"**differences**: {id_diffs}"),
         f"- Precision, recall, F1 (both arms, 50 rows): "
         + ("**identical**." if not metric_diffs else f"**differences**: {metric_diffs[:20]}"),
         f"- Expected findings: {expected_total}; SMT TP {smt_tp}, FP {smt_fp}.",
         f"- Query census on the same 50 policies: {sum(1 for r in bench if r['matches_expected'])}/50 "
         "finding sets equal the expected ids.", "",
         "## 3. SPEDIA (Table 3), current code", "",
         "| Variant | Paper (scope, coverage %, exposed, exposed anomaly) | Current code | Match |",
         "|---|---|---|---|"]
    for variant, paper, fresh in table3_rows:
        L.append(f"| {variant} | {paper} | {fresh} | {'yes' if paper == fresh else '**NO**'} |")
    L += ["", f"Replay CSVs vs. committed: "
          + ("**identical**." if not spedia_csv_diffs else f"**differences in {spedia_csv_diffs}**"), "",
          "Formal findings per SPEDIA variant (ids and counts compared; the finding schema changed):", "",
          "| Variant | Ids equal | Counts equal | Fields removed | Fields added |", "|---|---|---|---|---|"]
    for f in formal_rows:
        L.append(f"| {f['variant']} | {f['ids_equal']} | {f['counts_equal']} | {', '.join(f['fields_removed']) or '—'} | "
                 f"{', '.join(f['fields_added']) or '—'} |")
    L += ["", "## 4. Solver query outcomes (real Z3 queries)", "",
          f"Across {len(census)} analyses (50 controlled policies, 5 SPEDIA variants, example policy): "
          f"{totals['total']:,} queries; SAT {totals['sat']:,}; UNSAT {totals['unsat']:,}; UNKNOWN {totals['unknown']}. "
          f"Incomplete analyses: {sum(1 for r in census if r['analysis_status'] != 'complete')}.", "",
          "| Group | Analyses | Queries | SAT | UNSAT | UNKNOWN | Complete |", "|---|---:|---:|---:|---:|---:|---:|"]
    groups = [("benchmark n=" + str(s), [r for r in bench if r["label"].startswith(f"n{s}_")]) for s in SIZES]
    groups += [("SPEDIA variants", [r for r in census if r["kind"] == "spedia"]),
               ("example policy", [r for r in census if r["kind"] == "example"])]
    for name, group in groups:
        q = {k: sum(r["query_stats"][k] for r in group) for k in ("total", "sat", "unsat", "unknown")}
        L.append(f"| {name} | {len(group)} | {q['total']:,} | {q['sat']:,} | {q['unsat']:,} | {q['unknown']} | "
                 f"{sum(1 for r in group if r['analysis_status'] == 'complete')}/{len(group)} |")
    L += ["", "## 5. Tie-break change", "",
          ("No evaluated policy has two enabled rules with equal priority, so the switch from `localeCompare` to "
           "ordinal id order cannot change any decision in these experiments."
           if not ties else f"Policies with equal priorities: {ties}."), "",
          "## 6. Runtime: previous code (git HEAD) vs. current code, same machine", "",
          "Both runs used `experiments/run-benchmark.js` sequentially (previous code first). These numbers are a "
          "comparison on this machine only; they do not replace Table 2.", "",
          "| Rules | SMT previous (ms) | SMT current (ms) | Random previous (ms) | Random current (ms) |",
          "|---:|---|---|---|---|"]
    for size, o, n, ro, rn in runtime:
        L.append(f"| {size:,} | {o[0]:.1f} ± {o[1]:.1f} | {n[0]:.1f} ± {n[1]:.1f} | {ro[0]:.1f} ± {ro[1]:.1f} | "
                 f"{rn[0]:.1f} ± {rn[1]:.1f} |")
    L += ["", f"Finding ids, previous vs. current code (SMT and random, 50 runs): "
          + ("**identical**." if old_new_ids_equal else "**DIFFERENT**."), ""]
    (OUT / "regression_report.md").write_text("\n".join(L), "utf-8")
    (OUT / "regression_summary.json").write_text(json.dumps({
        "results_unchanged": results_unchanged, "benchmark_id_diffs": id_diffs, "benchmark_metric_diffs": metric_diffs,
        "table3_ok": table3_ok, "spedia_csv_diffs": spedia_csv_diffs, "formal": formal_rows, "query_totals": totals,
        "equal_priority_policies": ties, "old_new_ids_equal": old_new_ids_equal,
        "runtime": [{"size": s, "smt_previous": o, "smt_current": n, "random_previous": ro, "random_current": rn}
                    for s, o, n, ro, rn in runtime], "census_stdout": census_stdout.strip()}, indent=2), "utf-8")
    ok = results_unchanged and not id_diffs and not metric_diffs and table3_ok and not spedia_csv_diffs \
        and all(f["ids_equal"] and f["counts_equal"] for f in formal_rows) and totals["unknown"] == 0 and old_new_ids_equal
    print("\n".join(L))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
