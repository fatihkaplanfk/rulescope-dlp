# RuleScope-DLP

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

## Formal semantics and what a result means

**Notation.** D(e) is the valid event domain: each categorical attribute takes
one value of its declared domain, and `size_mb` is an integer in
`numeric_limits.size_mb`. C_i is rule i's condition clause and X_ik its k-th
exception clause. A clause is a conjunction over attributes; an array means
"any of these values"; `"*"` or an omitted attribute means "any value".

**Rule matching.** The effective match of an enabled rule is
`M_i(e) = C_i(e) ∧ ¬(X_i1(e) ∨ … ∨ X_in(e))`. A disabled rule never matches.
An empty exception list leaves `M_i = C_i`. An empty exception object `{}` has no
constraints, so it matches every event and the rule never matches.

**Priority.** A missing priority defaults to the rule's position. An explicitly
given priority must be an integer, or validation fails. Rules are ordered by
ascending priority; ties are broken by rule id in ordinal (UTF-16 code-unit)
order, shared by all components (`src/ordering.js`).

**Decisions and severity.** Severity order:
Permit < Audit < Warn < Encrypt < Quarantine < Block.
- `first_match`: the action of the first matching rule.
- `most_restrictive`: the strongest action among matching rules.
- Under both semantics, `default_action` applies only when no rule matches.

**Checks.** Every query includes D(e).

| Check | Query | Finding when | Evidence |
|---|---|---|---|
| Action conflict | ∃e. M_i ∧ M_j, with different actions | SAT | witness |
| Shadowing (first-match) | (1) ∃e. M_r ∧ ¬⋁_{p<r} M_p; (2) ∃e. M_r ∧ ⋁_{p<r} M_p | (1) UNSAT and (2) SAT | representative event |
| Redundancy | (1) ∃e. M_r ∧ dec_P(e) ≠ dec_{P∖r}(e); (2) ∃e. M_r | (1) UNSAT and (2) SAT | representative event |
| Coverage gap | ∃e. Q_j ∧ sev(dec_P(e)) < min_j | SAT | counterexample |
| Exception-linked requirement violation | ∃e. C_r ∧ X_rk ∧ Q_j ∧ sev(dec_P(e)) < min_j | SAT | counterexample |
| Semantic divergence | ∃e. dec^FM_P(e) ≠ dec^MR_P(e) | SAT | witness |

How to read the checks:
- **Shadowing and redundancy** are universal properties established by UNSAT. The
  second query only confirms that the rule's match set is not empty. Its event is
  an illustration (`evidence_kind: "representative_event"`), not a proof.
  - For shadowing, `covering_rule_set` lists the earlier rules whose union is
    proven to cover the rule; this set is not minimised.
  - `representative_event_matching_rules` lists only the rules that match the
    representative event.
- **Rules with an empty match set** are not reported by any check.
- **Coverage gap with an empty requirement scope.** UNSAT holds vacuously. This
  does not mean that any protected event exists.
- **Exception-linked violation** (finding type `exception_leakage`) reports an
  event inside the exception region that violates a requirement. It does not
  show that removing the exception would remove the violation:
  - the rule's own action may already be below the minimum;
  - under first-match, an earlier rule may decide the event.
  Every such event also satisfies the coverage-gap query of the same requirement.
- **Prefilter.** Before querying, pairs whose condition clauses cannot overlap are
  skipped. This over-approximates overlap (exceptions are ignored), so it never
  removes a rule that could match.

**Completeness.** Each report counts SAT, UNSAT and UNKNOWN queries
(`query_stats`). If any query is UNKNOWN, the report is marked
`analysis_status: "incomplete"`, the inconclusive queries are listed with the
solver's reason, and the CLI exits with code 3. An UNKNOWN result never counts
as UNSAT or as "no finding". The absence of a finding establishes the property
only for a complete analysis. Solver errors are not caught; they abort the
analysis.

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
