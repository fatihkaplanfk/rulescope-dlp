from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import FancyBboxPatch


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
FIGURES = RESULTS / "figures"
FIGURES.mkdir(parents=True, exist_ok=True)

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
})


def save(fig, name):
    fig.savefig(FIGURES / f"{name}.png", bbox_inches="tight", facecolor="white")
    fig.savefig(FIGURES / f"{name}.pdf", bbox_inches="tight", facecolor="white")
    fig.savefig(FIGURES / f"{name}.svg", bbox_inches="tight", facecolor="white")
    plt.close(fig)


def architecture_figure():
    """Create a compact monochrome workflow that remains legible at column width."""
    fig, ax = plt.subplots(figsize=(7.2, 5.2))
    ax.set_xlim(0, 12)
    ax.set_ylim(0, 10.5)
    ax.axis("off")
    boxes = [
        (3.1, 9.35, 5.1, 1.15, "Policy rules", "Priorities, actions, and exceptions"),
        (8.9, 9.35, 5.1, 1.15, "Protection requirements", "Scopes and minimum actions"),
        (6.0, 7.55, 8.6, 1.15, "Validation and normalization", "Domains, references, and schema checks"),
        (6.0, 5.65, 8.6, 1.20, "Bounded symbolic model", "Effective matches and policy decisions"),
        (6.0, 3.70, 8.6, 1.20, "Property-specific Z3 queries", "Five anomaly classes plus semantic divergence"),
        (3.1, 1.35, 5.1, 1.25, "SAT result", "Witness or counterexample"),
        (8.9, 1.35, 5.1, 1.25, "UNSAT result", "Unreachability or equivalence"),
    ]
    for cx, cy, width, height, title, subtitle in boxes:
        rect = FancyBboxPatch(
            (cx - width / 2, cy - height / 2), width, height,
            boxstyle="round,pad=0.05,rounding_size=0.07",
            linewidth=1.35, edgecolor="#202020", facecolor="#F2F2F2"
        )
        ax.add_patch(rect)
        ax.text(cx, cy + 0.18, title, ha="center", va="center", weight="bold", color="#111111", fontsize=11.2)
        ax.text(cx, cy - 0.24, subtitle, ha="center", va="center", color="#222222", fontsize=9.2)

    def arrow(start, end):
        ax.annotate(
            "", xy=end, xytext=start,
            arrowprops=dict(arrowstyle="-|>", color="#202020", lw=1.4, shrinkA=1, shrinkB=1)
        )

    arrow((3.1, 8.76), (4.55, 8.14))
    arrow((8.9, 8.76), (7.45, 8.14))
    arrow((6.0, 6.96), (6.0, 6.27))
    arrow((6.0, 5.03), (6.0, 4.32))
    arrow((5.15, 3.08), (3.65, 1.99))
    arrow((6.85, 3.08), (8.35, 1.99))
    save(fig, "fig1_architecture")


def runtime_figure(summary):
    x = summary["size"].to_numpy()
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    ax.errorbar(
        x, summary["exact_elapsed_ms_mean"], yerr=summary["exact_elapsed_ms_sd"],
        marker="o", linewidth=2, capsize=3, color="#1F77B4", label="PolicyLint-DLP (SMT)"
    )
    ax.errorbar(
        x, summary["random_elapsed_ms_mean"], yerr=summary["random_elapsed_ms_sd"],
        marker="s", linewidth=2, capsize=3, color="#D95F02", label="Uniform random testing (10,000 events)"
    )
    ax.set_xlabel("Number of policy rules")
    ax.set_ylabel("Analysis time (ms, log scale)")
    ax.set_yscale("log")
    ax.set_xticks(x)
    ax.grid(axis="y", which="both", alpha=0.25)
    ax.legend(frameon=False, loc="upper left")
    ax.set_title("Runtime scaling across controlled policy sizes", weight="bold")
    fig.text(0.5, 0.01, "Points show mean over 10 seeds; error bars show sample standard deviation.", ha="center", fontsize=8, color="#555555")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    save(fig, "fig2_runtime_scaling")


def effectiveness_figure(summary):
    x = np.arange(len(summary))
    width = 0.34
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    ax.bar(
        x - width / 2, summary["exact_f1_mean"], width,
        yerr=summary["exact_f1_sd"], capsize=3, label="PolicyLint-DLP (SMT)", color="#1F77B4"
    )
    ax.bar(
        x + width / 2, summary["random_f1_mean"], width,
        yerr=summary["random_f1_sd"], capsize=3, label="Uniform random testing", color="#D95F02"
    )
    ax.set_xlabel("Number of policy rules")
    ax.set_ylabel("F1 score")
    ax.set_xticks(x, summary["size"].astype(str))
    ax.set_ylim(0, 1.1)
    ax.grid(axis="y", alpha=0.25)
    ax.legend(frameon=False, loc="upper left", bbox_to_anchor=(1.01, 1.0))
    ax.set_title("Ground-truth anomaly recovery", weight="bold")
    fig.text(0.5, 0.01, "Each policy contains seven planted, independently verifiable findings; mean +/- SD over 10 seeds.", ha="center", fontsize=8, color="#555555")
    fig.tight_layout(rect=(0, 0.04, 0.82, 1))
    save(fig, "fig3_effectiveness")


def spedia_exposure_figure(replay):
    order = ["clean", "shadow_email", "exception_usb", "conflict_cloud", "combined_faults"]
    labels = ["Clean", "Email shadow", "USB exception", "Cloud conflict", "Combined faults"]
    first = replay[replay["semantics"] == "first_match"].set_index("variant").loc[order]
    x = np.arange(len(order))
    fig, ax = plt.subplots(figsize=(7.2, 4.3))
    ax.bar(x, first["exposed_anomaly"], color="#C0392B", label="Anomaly-labelled")
    ax.bar(
        x,
        first["exposed_non_anomaly"],
        bottom=first["exposed_anomaly"],
        color="#7F8C8D",
        label="Non-anomaly"
    )
    for index, value in enumerate(first["exposed_events"]):
        ax.text(index, value + 75, f"{int(value):,}", ha="center", va="bottom", fontsize=8.2)
    ax.set_xticks(x, labels, rotation=18, ha="right")
    ax.set_ylabel("Events below declared minimum action")
    ax.set_ylim(0, 5000)
    ax.grid(axis="y", alpha=0.25)
    ax.legend(frameon=False, loc="upper left")
    ax.set_title("Observed impact of policy mutations on SPEDIA replay", weight="bold")
    fig.text(
        0.5,
        0.01,
        "All 4,474 events shown are within one of three declared protection requirements; labels are used only after policy evaluation.",
        ha="center",
        fontsize=8,
        color="#555555"
    )
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    save(fig, "fig4_spedia_exposure")


def main():
    summary = pd.read_csv(RESULTS / "benchmark_summary.csv")
    replay = pd.read_csv(RESULTS / "spedia_replay_summary.csv")
    architecture_figure()
    runtime_figure(summary)
    effectiveness_figure(summary)
    spedia_exposure_figure(replay)
    print(f"Wrote figures to {FIGURES}")


if __name__ == "__main__":
    main()
