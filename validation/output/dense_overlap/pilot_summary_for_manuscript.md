# Dense-overlap pilot — measured results only

Source: `pilot_runs.json`, `structure.json`, `run_manifest.json`, and `pilot/*/progress.jsonl` and
`stderr.txt` in this folder. The experiment is closed at these 12 runs. No extrapolation to
larger policy sizes is included.

## Setup
- Policies are generated with frozen parameters (`params.json`).
- Grid: 50 and 100 rules × sparse/medium/dense overlap × seeds 1 and 2.
- Policy configuration: first-match semantics, default Permit, 5 requirements, exceptions on
  10% of rules.
- All six checks run, including semantic divergence.
- Limits: 10 s per solver query, 10 min wall clock per process.
- Each run is a separate process. Runs were sequential, in a fixed random order, on one machine.

**Environment** (from `run_manifest.json`):

| Item | Value |
|---|---|
| OS | Windows 11 (Windows_NT 10.0.26200, x64) |
| CPU | 13th Gen Intel Core i9-13900H, 20 logical CPUs |
| RAM | 15.73 GiB |
| Node.js | v24.14.0 |
| z3-solver | 4.16.0 |
| Source | git HEAD 6950826 plus uncommitted changes; SHA-256 of every source file recorded |

## Results

Notes on the columns:
- **Analysis time** is measured inside `analyze()`. It excludes process start-up, policy
  generation and Z3 initialisation.
- **Prefilter candidate ratio** is the share of rule pairs, or of different-action rule pairs,
  that pass the syntactic overlap prefilter. It is not a true-overlap ratio.

| Rules | Overlap level | Completed / started | Analysis time per completed run (s) | Mean (s) | Prefilter candidate ratio, all pairs (s1; s2) | Prefilter candidate ratio, different-action pairs (s1; s2) |
|---:|---|:---:|---|---:|---|---|
| 50 | sparse | 2/2 | 0.86; 0.95 | 0.91 | 0.0%; 0.0% | 0.0%; 0.0% |
| 50 | medium | 2/2 | 8.44; 8.13 | 8.28 | 33.2%; 34.1% | 34.3%; 33.3% |
| 50 | dense | 2/2 | 13.35; 12.48 | 12.92 | 55.4%; 51.0% | 55.5%; 50.6% |
| 100 | sparse | 2/2 | 1.60; 1.68 | 1.64 | 0.0%; 0.0% | 0.0%; 0.0% |
| 100 | medium | 2/2 | 19.24; 18.50 | 18.87 | 21.3%; 20.6% | 21.6%; 20.1% |
| 100 | dense | **0/2** | — | — | 42.3%; 39.4% | 42.0%; 39.2% |

All 10 completed runs had zero UNKNOWN queries.

## Runs that did not complete

| Run | Status | Stage reached | Queries answered before stopping (SAT/UNSAT/UNKNOWN) | Recorded cause |
|---|---|---|---|---|
| 100 rules, dense, seed 1 | failed after 38.1 s | redundancy | 1,783 (1,742/41/0) | Z3 WebAssembly heap exhausted at its fixed 2 GiB limit (`stderr.txt`) |
| 100 rules, dense, seed 2 | aborted at the 10 min wall-clock limit | redundancy | 1,589 (1,547/42/0) | No query completed during the last ~575 s; the cause was not determined |

In both runs, the action-conflict, shadowing and earlier stages finished, but the
analysis did not. These runs are not included in any mean.

## Suggested manuscript text

> A pilot scalability experiment generated policies with controlled overlap from anchor events,
> wildcards, multi-valued conditions and overlapping size ranges (50 and 100 rules; sparse,
> medium and dense overlap; two seeds each; first-match semantics; per-query timeout 10 s;
> per-process limit 10 min). All ten runs at 50 rules and at 100 rules with sparse or medium
> overlap completed, with mean analysis times between 0.91 s and 18.87 s and no inconclusive
> solver queries. Neither run at 100 rules with dense overlap completed (prefilter candidate
> ratios of 42.3% and 39.4% of rule pairs). One exhausted the 2 GiB WebAssembly memory of the
> Z3 build during the redundancy check. The other stopped at the wall-clock limit during the
> same check, for an undetermined reason. The current implementation therefore did not scale to
> densely overlapping policies of 100 rules in this setting.
