# Coverage-guided testing baseline: method

This baseline answers SAUCIS Reviewer 2's request for a testing baseline stronger than uniform
sampling. It is a simple, reproducible, coverage-guided generator built on the same normalized
policy representation and the same concrete first-match evaluator as the uniform baseline. It
is **not** a state-of-the-art fuzzer. It is a more informed comparison point than uniform
sampling.

Code: `validation/coverage_guided/` (`coverage_guided.mjs`, `worker.mjs`, `run.mjs`,
`regression.py`). No file under `src/`, `benchmark/`, `experiments/`, `test/` or `results/` was
changed.

## 1. Audit: reused components

| Component | Source | Use |
|---|---|---|
| Controlled policies | `benchmark/generator.js` → `generateBenchmarkPolicy(size, seed)` | The same 50 policies: sizes 50/100/250/500/1,000 × seeds 1–10, 7 expected ids each, 350 in total |
| Uniform event generator | `src/baseline.js` → `randomEvent`, `mulberry32` | Seed corpus and "fresh" exploration events |
| Concrete evaluator | `src/evaluator.js` → `ruleMatches`, `clauseMatches`, `evaluatePolicy(…, "first_match")` | Every coverage observation and finding observation |
| Canonical ids | `src/analyzer.js` → `findingId` | Identical id format, e.g. `shadowing:SH2` |
| Severity order | `src/schema.js` → `ACTION_SEVERITY` | Requirement and exception checks |
| Uniform baseline | `src/baseline.js` → `analyzeByRandomTesting` (unchanged) | Re-run in the same process as the reference arm |
| Observation definitions | Observation part of `analyzeByRandomTesting` | Copied verbatim into `observeFindings(policy, events)`, with event generation removed |
| Metrics | `experiments/benchmark-worker.js` → `classificationMetrics` | Same precision/recall/F1 formulas, plus raw TP/FP/FN |

**Equivalence of the observation copy.** In every run, the worker regenerates the uniform
baseline's 10,000 events (same `mulberry32` seed, `seed*1009+size`) and applies
`observeFindings` to them. The resulting id list must equal the output of
`analyzeByRandomTesting`, element for element. It did in 50/50 runs.

**Information barrier.** `runCoverageGuided(policy, options)` receives only the validated policy
object. It reads rule ids only as opaque coverage-key labels, and it reads clause constraints
for splicing (§3). It never reads rule descriptions, actions-as-labels, `expectedFindingIds`,
SMT output, witnesses or counterexamples. Ground-truth ids are used only after both baselines
have finished, for scoring.

## 2. Coverage model (concrete feedback only)

Each evaluated event produces a set of coverage keys:

| Key | Meaning |
|---|---|
| `m:<rule>` | rule matched (conditions hold and no exception applies) |
| `f:<rule>` / `f:<default>` | rule selected by first-match evaluation (or the default action) |
| `p:<a>\|<b>` | two rules co-matched on the same event |
| `r:<req>` | requirement scope reached |
| `v:<req>` | requirement violation observed (final action below the minimum) |
| `x:<rule>:<i>` | exception clause *i* triggered while the rule's conditions held |
| `a:<action>` | distinct final action |

Coverage state starts empty for every policy. The keys do not encode any anomaly type or
planted id. For example, a `p:` key is recorded for every co-match, whether or not the two
actions differ.

## 3. Event generation

The budget is **10,000 evaluated events per policy**, the same as the uniform baseline. Every
evaluated candidate consumes one unit of budget, whether or not it adds coverage. The RNG is
`mulberry32(seed*1009 + size + 104729)`, a fixed stream distinct from the uniform baseline's.

1. **Seed corpus.** 100 uniform events from `randomEvent`. Each is evaluated. Events that add
   new coverage enter the corpus.
2. **Main loop**, until 10,000 events have been evaluated:
   - With probability 0.10, or if the corpus is empty, the candidate is a fresh uniform event.
   - Otherwise, a parent is drawn uniformly from the corpus and copied. Then 1–3 mutation
     operators (count uniform) are applied, each chosen with these weights:
     - **Categorical point mutation (0.45).** Pick an attribute uniformly and replace its value
       with a different value drawn uniformly from the declared domain.
     - **Clause splice (0.25).** Pick one clause uniformly from all enabled rule conditions,
       exception clauses and requirement conditions. Copy a uniformly sized random subset of
       its non-wildcard constraints into the event: scalar → that value; array → a random
       element; size range → uniform within the range intersected with the declared interval.
       Values outside the declared domain are never written. This is a standard
       "dictionary/constant" heuristic that uses the policy's declared constants. It applies
       equally to every clause and has no knowledge of which clauses are planted.
     - **Boundary-aware size mutation (0.30).** With probability 0.5, pick a value from the
       boundary set: the interval limits plus every clause size constant or range limit ±1,
       clipped to the declared interval. With probability 0.25, add ±1..16. Otherwise draw
       uniformly from the declared interval.
   - The candidate is evaluated. If it yields any coverage key not seen before, it is added to
     the corpus.
3. **Finding observation.** `observeFindings` is applied to **all** 10,000 evaluated events,
   using exactly the uniform baseline's definitions: different-action co-matches give an
   action conflict; matched but never first-match-selected gives observed shadowing; matched
   but removal never changes a decision gives observed redundancy; a requirement-scope event
   below the minimum gives a coverage gap; and condition, exception and requirement match with
   the decision below the minimum gives exception-linked violation. A rule must be matched at
   least once before it can be reported as shadowed or redundant.

No attribute leaves its declared domain, and `size_mb` stays within `numeric_limits`.

## 4. Timing definitions

Both arms run in the same worker process, one Node.js process per (size, seed), sequentially.

- **Uniform time:** `performance.now()` around `analyzeByRandomTesting(policy, {samples: 10000})`.
  This covers generation and evaluation of 10,000 events, the same definition as in the
  manuscript.
- **Coverage-guided time:** `performance.now()` around `runCoverageGuided(policy, {budget: 10000})`.
  This covers seed-corpus generation, mutations, coverage bookkeeping, concrete evaluation of
  every candidate and the full finding-observation pass. The observation pass re-evaluates all
  10,000 events, so concrete evaluation is effectively done twice. This is conservative against
  the coverage-guided arm.
- **Excluded from both:** process start-up, module loading, policy generation and the untimed
  equivalence and coverage checks that run afterwards. Z3 is not loaded in this experiment.
- **Order:** for odd seeds the uniform arm runs first, for even seeds the coverage-guided arm,
  to balance JIT warm-up.
- **Machine:** the audit workstation (see `coverage_guided_summary.md`). This is not the
  environment of the published Table 2, so these times are a same-machine comparison of the two
  testing arms only. The uniform effectiveness results are deterministic and equal the
  published ones; the published uniform times are not reproduced here.

## 5. Commands

```bash
npm ci
node validation/coverage_guided/run.mjs
python validation/coverage_guided/regression.py --before-hashes validation/output/coverage_guided_results_hashes_before.txt
```

Seeds: policies 1–10 per size; uniform arm `seed*1009+size`; coverage-guided arm
`seed*1009+size+104729`. Budget: 10,000. Run time on the audit workstation: about 10 min for the
experiment and about 2.5 min for the regression.

## 6. Limitations of the design

- Operator weights, the seed-corpus size, the exploration probability and the coverage keys were
  chosen once, before the run, and were not tuned on the results. Other reasonable choices
  could perform better or worse.
- The coverage model rewards reaching every rule. In large policies most keys come from the
  many base rules, so the search spends its budget there (§ results). This is a known property
  of simple coverage-guided search, not a tuned weakness.
- The clause-splice operator uses declared policy constants. This is a generic heuristic, but
  it is a form of white-box guidance that uniform sampling does not have.
- The manuscript currently argues that coverage-guided generation "would introduce search
  heuristics tailored to individual anomaly classes". The baseline here avoids anomaly-specific
  heuristics, so that sentence should be revised if this experiment is reported.
