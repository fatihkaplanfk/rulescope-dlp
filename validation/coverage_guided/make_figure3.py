#!/usr/bin/env python3
"""Manuscript Figure 3 (runtime scaling) with the RuleScope-DLP legend label.

Calls the unchanged runtime_figure() from experiments/make_figures.py on the
committed results/benchmark_summary.csv. The only redirection is the output
folder, so that results/figures/ is not overwritten. The plotted data and the
plotting code are those of the published figure; only the legend label differs,
because make_figures.py was renamed to RuleScope-DLP.

Usage: python validation/coverage_guided/make_figure3.py
"""

import hashlib
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "validation" / "output" / "figures"
sys.path.insert(0, str(ROOT / "experiments"))
import make_figures  # noqa: E402  (importing only creates results/figures/ if missing)

SUMMARY = ROOT / "results" / "benchmark_summary.csv"
EXPECTED_SUMMARY_SHA256 = "f20026aa18a227d2cf361cca834386bc83e09597cf1114e1ecf72b9e02aa649e"  # MANIFEST.sha256


def main() -> None:
    digest = hashlib.sha256(SUMMARY.read_bytes()).hexdigest()
    if digest != EXPECTED_SUMMARY_SHA256:
        raise SystemExit(f"results/benchmark_summary.csv differs from the manifest: {digest}")
    OUT.mkdir(parents=True, exist_ok=True)
    make_figures.FIGURES = OUT  # save() reads this module global
    make_figures.runtime_figure(pd.read_csv(SUMMARY))
    for ext in ("png", "pdf", "svg"):
        (OUT / f"fig2_runtime_scaling.{ext}").replace(OUT / f"figure3_runtime.{ext}")
    print(f"Wrote {OUT / 'figure3_runtime'}.png/.pdf/.svg")


if __name__ == "__main__":
    main()
