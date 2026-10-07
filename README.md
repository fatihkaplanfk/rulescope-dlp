RuleScope-DLP
<<<<<<< HEAD
=======

RuleScope-DLP is a research prototype for explainable, solver-aided verification of multi-channel enterprise data loss prevention policies. It translates a vendor-neutral JSON policy into SMT constraints and returns concrete witness transfers for five anomaly classes:

- action conflicts;
- first-match shadowing;
- semantic redundancy;
- coverage gaps against explicit protection requirements; and
- exception leakage against explicit protection requirements.

The prototype also compares `first_match` and `most_restrictive` combining semantics. Its formal benchmark uses controlled synthetic policies because the planted configuration defects require exact ground truth. A separate trace-replay experiment measures the operational effect of those defects on the independently published, annotated SPEDIA event dataset. No corporate policy or event data is included.

## Requirements

- Node.js 20 or later
- npm

## Install and verify

```bash
npm ci
npm test
npm run lint
```

## Analyze the example policy

```bash
npm run analyze
```

Equivalent direct invocation:

```bash
node src/cli.js analyze examples/sample-policy.json --format text
node src/cli.js analyze examples/sample-policy.json --format json
node src/cli.js analyze examples/sample-policy.json --semantics most_restrictive
```

The JSON schema is intentionally compact. A rule contains an identifier, priority, condition clause, optional exception clauses, and action. An omitted attribute or `"*"` is a wildcard. Scalar values, arrays, and inclusive numeric `size_mb` ranges are supported. Coverage and exception-leakage checks are evaluated against explicit `requirements`; the analyzer does not assume that every transfer must be blocked.

## Reproduce the experiment

The paper experiment uses five policy sizes, ten deterministic seeds per size, and 10,000 uniformly generated test events for the sampling baseline:

```bash
npm run benchmark
```

To run a smaller smoke benchmark:

```bash
node experiments/run-benchmark.js --sizes 50,100 --seeds 1,2 --samples 10000
```

The command writes per-run JSON, aggregate CSV files, and representative witnesses to `results/`. Generate the paper figures with:

```bash
python experiments/make_figures.py
```

`most_restrictive` uses the policy default only as a fallback when no rule
matches. If one or more rules match, the decision is the strongest action among
those matching rules; the default action does not compete with them.

### Reproduce the SPEDIA trace replay

The raw SPEDIA CSV is not redistributed. Download the CC BY 4.0 annotated release, verify its published file identity, normalize only DLP-relevant email, HTTP, file, and removable-device records, and run the experiment:

```bash
python experiments/fetch_spedia.py
npm run spedia
npm run figures
```

The experiment replays 56,737 records through a clean reference policy and four deterministic policy-mutation variants. It reports observed requirement coverage and the number of labelled anomalous/non-anomalous events exposed by each fault. `Anomaly`, `Agent_name`, and `User` are excluded from all policy decision features; the outcome label is consulted only after decisions have been made. See `data/README.md` for the DOI, license, file checksum, and acquisition details.

## Project layout

- `src/`: schema, evaluator, Z3 analyzer, CLI, reports, and random-testing baseline
- `benchmark/`: deterministic controlled-policy generator and planted ground truth
- `experiments/`: benchmark runner and figure generator
- `data/`: external-dataset citation, license, checksum, and acquisition instructions (raw data excluded)
- `examples/`: minimal multi-channel DLP policy
- `test/`: unit and integration tests
- `results/`: raw runs, summaries, witnesses, and figures reported in the manuscript

## Scope and limitations

This is a research artifact rather than a production DLP policy importer. Its action ordering is configurable only through the prototype's fixed severity lattice, its categorical domains are finite, and only first-match and most-restrictive semantics are implemented. SPEDIA is an insider-threat corpus rather than a native DLP-policy corpus; its metadata supports operational trace replay but not direct evaluation of content classification. A deployment study with authorized enterprise policies is future work.

## License

MIT. See `LICENSE`.
