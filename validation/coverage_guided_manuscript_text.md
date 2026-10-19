# Proposed manuscript text: coverage-guided baseline (not applied to the manuscript)

All numbers are from `coverage_guided_summary.md` and `coverage_guided_results.csv` (run of
2026-10-07). The runtime ratio was measured on a different machine than Table 2 and is stated as
such.

## Materials and Methods

> To address whether the comparison depends on the weakness of uniform sampling, a second
> testing baseline was added. It is coverage-guided, but it is not intended to represent
> state-of-the-art fuzzing. It operates on the same normalized policy representation, uses the
> same concrete first-match evaluator and has the same budget of 10,000 evaluated events per
> policy. Starting from 100 uniformly sampled events, it retains every event that produces new
> concrete-execution coverage: a newly matched or first-match-selected rule, a rule pair
> co-matching the same event, a reached requirement scope, an observed requirement violation, a
> triggered exception clause or a new final action. New candidates are derived from retained
> events by categorical point mutation, by splicing constants from a randomly chosen policy
> clause and by boundary-aware file-size mutation. Ten percent of candidates are fresh uniform
> events, and no value leaves its declared domain. Every evaluated candidate consumes budget.
> Findings are derived from all evaluated events using exactly the observation definitions and
> canonical identifiers of the uniform baseline; the observation code reproduced the uniform
> baseline's output on its own events in all 50 runs. Neither ground-truth identifiers nor
> solver output are available to the generator. Its reported time covers corpus generation,
> mutation, coverage bookkeeping, concrete evaluation and finding observation. Both testing
> baselines were timed in the same process on the same machine. That machine differs from the
> environment used for the symbolic-analysis times in Table 2.

## Results

> The coverage-guided baseline recovered 294 of the 350 expected finding identifiers, with no
> false positives and 56 false negatives. Its mean per-run F1 was 0.880 ± 0.235, compared with
> 95 recovered identifiers, two false positives and a mean F1 of 0.366 ± 0.305 for uniform
> sampling. Its advantage declined with policy size. It recovered all expected findings in every
> 50- and 100-rule policy, and its mean F1 was 0.956 at 250 rules, 0.886 at 500 rules and
> 0.557 ± 0.351 at 1,000 rules (uniform: 0.406 ± 0.306). At 1,000 rules it reached on average
> 578 of the 1,000 rules and was still discovering new coverage at the end of the budget. Two
> 1,000-rule runs recovered no expected finding. Measured on the same machine, the
> coverage-guided baseline required on average 2.1 times the uniform baseline's time
> (1.9–2.4 times across runs). The SMT analyzer recovered all 350 findings without false
> positives, as reported in Table 2.

## Discussion (limitation)

> The coverage-guided baseline is a simple, untuned generator with fixed operator weights and a
> single coverage model. It narrows the gap to the symbolic analysis on small and medium
> policies, but it does not bound how a dedicated fuzzer or constraint-guided test generator
> would perform. Its clause-splicing operator also exploits declared policy constants, which is
> a form of white-box guidance. Its declining recall on larger policies reflects a fixed budget
> spread over many coverage targets, not a limit of testing in general. In both testing
> baselines, unobserved behaviour remains unreported, whereas solver-based analysis decides
> each property over the complete bounded model.

## Draft response to Reviewer 2

> We thank the reviewer for this suggestion. In addition to the uniform random-testing
> baseline, we implemented a coverage-guided testing baseline. It uses the same normalized
> policy representation, the same concrete first-match evaluator, the same 10,000-event budget
> per policy, and identical finding-observation definitions and canonical identifiers. It
> retains events that yield new concrete coverage (rules matched or selected, rule-pair
> co-matches, requirement scopes, requirement violations, exception triggers and final actions)
> and mutates them using categorical, clause-splicing and boundary-aware size operators. It has
> no access to ground-truth identifiers or solver output.
>
> On the 50 controlled policies, it recovered 294 of 350 expected findings with no false
> positives (mean F1 0.880 ± 0.235). For comparison, uniform sampling recovered 95 findings with
> two false positives (mean F1 0.366 ± 0.305), and the SMT analyzer recovered 350 with no false
> positives. The coverage-guided baseline recovered all findings in the 50- and 100-rule
> policies, but its mean F1 fell to 0.557 at 1,000 rules, where coverage was not saturated
> within the budget. On a common machine it took about 2.1 times as long as uniform sampling.
> We now report this baseline in Section [X] and Table [Y]. We describe it explicitly as a
> simple coverage-guided generator rather than a state-of-the-art fuzzer, and we have revised the
> earlier statement that coverage-guided generation would require anomaly-specific heuristics.
> The original uniform-baseline results, the SMT results and Table 2 are unchanged. Code, seeds,
> per-run outputs and a regression check are included in the artifact.

## Notes for the authors

- Remove or revise the existing Materials and Methods sentence stating that coverage-guided
  generation "would introduce search heuristics tailored to individual anomaly classes".
- Do not merge the new runtimes into Table 2. They come from a different machine. If a table
  is added, label it with that machine, or report only the relative ratio measured on one
  machine.
- Do not claim that the coverage-guided baseline represents state-of-the-art fuzzing.
