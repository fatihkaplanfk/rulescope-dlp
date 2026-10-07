# Changelog

## Unreleased

- Renamed the project from PolicyLint-DLP to RuleScope-DLP (package and CLI
  name `rulescope-dlp`) to avoid confusion with the unrelated PolicyLint
  privacy-policy analyzer of Andow et al. This is a naming-only change:
  algorithms, policy semantics, benchmark generation, seeds and all reported
  results are unchanged. Committed figures still carry the old legend label
  until they are regenerated.

## 0.2.1 — 2026-08-12

- Corrected `most_restrictive` so that `default_action` is used only when no
  rule matches; when rules match, only their actions compete.
- Added concrete and symbolic regression tests for a restrictive default with
  a weaker matching rule.
- Added scalable SVG figure output and improved the architecture workflow.
- Re-ran the controlled benchmark and SPEDIA trace replay from the corrected
  source tree.

## 0.2.0 — 2026-08-12

- Added the SPEDIA label-safe trace-replay experiment.
- Added controlled mutation policies, ground-truth evaluation, and figures.
