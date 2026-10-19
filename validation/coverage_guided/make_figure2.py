#!/usr/bin/env python3
"""Manuscript Figure 2 with three series: SMT, uniform random, coverage-guided.

Style follows effectiveness_figure() in experiments/make_figures.py. Values are
computed from the result files, never typed in:
  - SMT and uniform random: results/benchmark_summary.csv (committed, unchanged)
  - coverage-guided: validation/coverage_guided_results.csv (mean and sample SD
    over the ten seeds per size)
The computed values are checked against the expected rounded values before
plotting. Output goes to validation/output/figures/; results/figures/ is not
touched.

Usage: python validation/coverage_guided/make_figure2.py
"""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "validation" / "output" / "figures"
NAME = "figure2_recovery_three_baselines"

# Rounded values reported in Table 2 and coverage_guided_summary.md. Used only
# as a consistency check of the computed values.
EXPECTED = {
    "smt_mean": [1.000, 1.000, 1.000, 1.000, 1.000], "smt_sd": [0.000] * 5,
    "random_mean": [0.415, 0.396, 0.292, 0.322, 0.406], "random_sd": [0.376, 0.291, 0.242, 0.336, 0.306],
    "guided_mean": [1.000, 1.000, 0.956, 0.886, 0.557], "guided_sd": [0.000, 0.000, 0.096, 0.122, 0.351],
}

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9,
    "axes.titlesize": 11,
    "axes.labelsize": 9,
    "legend.fontsize": 8,
    "figure.dpi": 140,
    "savefig.dpi": 300,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "svg.fonttype": "none",
})


def main() -> None:
    summary = pd.read_csv(ROOT / "results" / "benchmark_summary.csv").sort_values("size")
    runs = pd.read_csv(ROOT / "validation" / "coverage_guided_results.csv")
    guided = runs.groupby("size")["guided_f1"].agg(["mean", "std", "count"]).loc[summary["size"]]
    if not (guided["count"] == 10).all():
        raise SystemExit(f"Expected 10 runs per size, got {guided['count'].tolist()}")

    values = {
        "smt_mean": summary["exact_f1_mean"].to_numpy(), "smt_sd": summary["exact_f1_sd"].to_numpy(),
        "random_mean": summary["random_f1_mean"].to_numpy(), "random_sd": summary["random_f1_sd"].to_numpy(),
        "guided_mean": guided["mean"].to_numpy(), "guided_sd": guided["std"].fillna(0).to_numpy(),  # pandas std = sample SD
    }
    for key, expected in EXPECTED.items():
        computed = np.round(values[key], 3)
        if not np.allclose(computed, expected, atol=5e-4):
            raise SystemExit(f"{key}: computed {computed.tolist()} != expected {expected}")

    x = np.arange(len(summary))
    width = 0.26
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    series = [
        ("smt", "RuleScope-DLP (SMT)", "#1F77B4", -width),
        ("random", "Uniform random testing", "#D95F02", 0.0),
        ("guided", "Coverage-guided testing", "#1B9E77", width),
    ]
    for key, label, color, offset in series:
        ax.bar(x + offset, values[f"{key}_mean"], width, yerr=values[f"{key}_sd"], capsize=3,
               label=label, color=color, error_kw={"elinewidth": 1, "ecolor": "#222222"})
    ax.set_xlabel("Number of policy rules")
    ax.set_ylabel("F1 score")
    ax.set_xticks(x, [f"{int(s):,}" for s in summary["size"]])
    ax.set_ylim(0, 1.15)
    ax.set_yticks(np.arange(0, 1.01, 0.2))
    ax.grid(axis="y", alpha=0.25)
    ax.legend(frameon=False, loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3)
    ax.set_title("Ground-truth anomaly recovery", weight="bold", pad=24)
    fig.text(0.5, 0.01,
             "Each policy contains seven planted, independently verifiable findings.\n"
             "Bars: mean F1 over 10 seeds; error bars: sample SD; 10,000 evaluated events per testing baseline.",
             ha="center", fontsize=7.5, color="#555555")
    fig.tight_layout(rect=(0, 0.07, 1, 1))

    OUT.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "pdf", "svg"):
        fig.savefig(OUT / f"{NAME}.{ext}", bbox_inches="tight", facecolor="white")
    plt.close(fig)

    table = pd.DataFrame({"rules": summary["size"].to_numpy(), **{k: np.round(v, 3) for k, v in values.items()}})
    table.to_csv(OUT / f"{NAME}_data.csv", index=False)
    print(table.to_string(index=False))
    print(f"Wrote {OUT / NAME}.png/.pdf/.svg")


if __name__ == "__main__":
    main()
