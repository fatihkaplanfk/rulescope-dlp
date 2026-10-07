# Rename audit: PolicyLint-DLP → RuleScope-DLP

Date: 2026-10-07. Scope: this local repository only. Nothing was committed, pushed or
published. The remote GitHub repository was not renamed, and git history was not modified.

This is a naming-only change. No algorithm, policy semantics, benchmark generator logic, seed,
dataset, result file or validation finding was changed (see the verification section).

## 1. Audit before modification

The search covered the whole repository except `.git/`, `node_modules/` and the SPEDIA CSV. It
was case-insensitive and used the pattern `policy ?lint|policylintdlp`, which covers
`PolicyLint-DLP`, `PolicyLint_DLP`, `PolicyLintDLP`, `policyLint-dlp`, `policylint-dlp`,
`policyLint` and `PolicyLint`. It found 37 occurrences in 19 files, plus the repository root
folder name.

| # | Location | Text | Category | Action |
|---:|---|---|---|---|
| 1 | `README.md:1` | `# PolicyLint-DLP` | documentation / project name | renamed |
| 2 | `README.md:3` | `PolicyLint-DLP is a research prototype…` | documentation / project name | renamed |
| 3 | `CITATION.cff:2` | citation message | citation metadata | renamed |
| 4 | `CITATION.cff:3` | citation title | citation metadata | renamed |
| 5 | `CITATION.cff:25` | `https://github.com/fatihkaplanfk/policyLint-dlp` | URL | renamed |
| 6 | `package.json:2` | `"name": "policylint-dlp"` | package metadata | renamed |
| 7 | `package.json:8` | bin `policylint-dlp` | package metadata / CLI name | renamed |
| 8–10 | `package.json:37,39,41` | repository, homepage, bugs URLs | package metadata / URL | renamed |
| 11–13 | `package-lock.json:2,8,15` | root package name and bin, mirrored from package.json | package metadata | renamed (hand edit, no other lockfile change) |
| 14 | `src/cli.js:13` | `Usage: policylint-dlp analyze …` | CLI help text | renamed |
| 15 | `src/report.js:7` | `PolicyLint-DLP Analysis Report` | example/report output heading | renamed |
| 16 | `src/analyzer.js:8` | `` `policylint_${Date.now()}` `` (Z3 context name) | source identifier (internal) | **kept**, see §4 |
| 17 | `src/cli.js:29` | `"policylint_cli"` (Z3 context name) | source identifier (internal) | **kept**, see §4 |
| 18 | `benchmark/generator.js:123` | policy name label `PolicyLint-DLP controlled benchmark …` | project-name label in generated policy | renamed (label only; verified below) |
| 19 | `experiments/prepare_spedia.py:2` | module docstring | comment | renamed (docstring only) |
| 20 | `experiments/fetch_spedia.py:52` | HTTP `User-Agent: PolicyLint-DLP/0.2` | project name | renamed |
| 21–22 | `experiments/make_figures.py:79,103` | legend label `PolicyLint-DLP (SMT)` | figure label | renamed (affects future figure regeneration only) |
| 23 | `experiments/run-spedia-replay.js:18` | temp-dir prefix `policylint-spedia-` | source identifier (internal) | **kept**, see §4 |
| 24 | `data/ATTRIBUTION.md:12` | `PolicyLint-DLP does not change…` | documentation | renamed |
| 25–29 | `GITHUB_YUKLEME_TR.md:3,13,14,17,32` | name, clone URL, `cd` path, ZIP folder name, commit message | reproducibility instructions / URL | renamed |
| 30 | `results/figures/fig2_runtime_scaling.svg:1645` | `<!-- PolicyLint-DLP (SMT) -->` plus the rendered legend text | generated experimental output | **not changed**, reported (§5) |
| 31 | `results/figures/fig3_effectiveness.svg:1331` | `<!-- PolicyLint-DLP (SMT) -->` plus the rendered legend text | generated experimental output | **not changed**, reported (§5) |
| 32–33 | `validation/regression_check.py:34–35` | manuscript file names `03_PolicyLint_DLP_SAUCIS_Author.tex`, `PolicyLint_DLP_SAUCIS_.docx` | comment naming existing files outside the repo | **kept**, see §4 |
| 34 | `validation/regression_check.py:84` | temp-dir prefix `policylint-regression-` | source identifier (internal) | **kept**, see §4 |
| 35 | `validation/scope_pool_reconciliation.py:73` | temp-dir prefix `policylint-recon-` | source identifier (internal) | **kept**, see §4 |
| 36 | `MANIFEST.sha256` | (no name; hashes of the renamed files) | artifact metadata | hashes refreshed for edited files only |
| 37 | repository folder `policyLint-dlp/` | local folder name | file/folder name | see §3 |

The audit categories map as follows:

- References to Andow et al.'s PolicyLint: **none** in the repository (see §6).
- File or folder names: only the repository root folder.
- Tests: no test name or assertion contains the old name.
- Badges: none exist in the README.
- Generated experimental outputs: only the two SVG figures (and their PNG/PDF renderings). No
  CSV, JSON or raw result contains the name.

## 2. Changed files

`README.md`, `CITATION.cff`, `CHANGELOG.md` (new "Unreleased" entry describing the rename),
`package.json`, `package-lock.json`, `src/cli.js`, `src/report.js`, `benchmark/generator.js`,
`experiments/prepare_spedia.py`, `experiments/fetch_spedia.py`, `experiments/make_figures.py`,
`data/ATTRIBUTION.md`, `GITHUB_YUKLEME_TR.md`, `MANIFEST.sha256`.

- **MANIFEST.sha256:** only the hashes of the edited files listed above were refreshed, plus
  `.gitignore`, which gained `node_modules/` in the earlier validation session. The file list
  is unchanged, no `results/` entry changed, and `sha256sum -c MANIFEST.sha256` passes for
  all entries.
- **Unchanged:** `results/`, `test/`, `examples/`, `experiments/spedia-policy.js`,
  `experiments/run-spedia-replay.js`, `experiments/run-benchmark.js`,
  `experiments/benchmark-worker.js` and `src/analyzer.js`, `src/evaluator.js`,
  `src/schema.js`, `src/baseline.js`.

## 3. Renamed files and directories

No file inside the repository contains the old name. The only path that carries it is the local
repository root folder. It was renamed from `policyLint-dlp/` to `rulescope-dlp/` as the last
step. After the folder rename, `npm test` was run again from the new path: 7/7 tests pass. The
folder name is not stored in git, so the rename creates no git change.

## 4. Occurrences deliberately kept

- **Internal identifiers:** `policylint_${Date.now()}`, `policylint_cli` (Z3 context names) and
  the temporary-directory prefixes `policylint-spedia-`, `policylint-regression-` and
  `policylint-recon-` are internal and never shown to users. The first three are in the
  analyzer, CLI and replay code. Changing them has no user-visible benefit and touches code paths
  that must stay unchanged. None of them matches the final-search terms.
- **Manuscript file names** in a comment in `validation/regression_check.py` name existing
  files outside the repository. If the manuscript files are renamed, update that comment.

## 5. Generated outputs reported, not changed

`results/figures/fig2_runtime_scaling.{svg,png,pdf}` and
`results/figures/fig3_effectiveness.{svg,png,pdf}` show the legend label "PolicyLint-DLP (SMT)".
They were left unchanged, as instructed. To relabel them without touching data:

```bash
npm run figures
```

This re-renders the figures from the unchanged `results/benchmark_*.csv` with the new label in
`experiments/make_figures.py`. Afterwards, check that only the label changed and refresh the
figure entries in `MANIFEST.sha256`. The manuscript's own figure files, outside the
repository, need the same treatment.

## 6. Literature references to PolicyLint (Andow et al.)

The repository contains no reference to Andow et al. or to "PolicyLint: Investigating internal
privacy policy contradictions on Google Play". Such references exist only in the manuscript files
outside the repository, which were not touched. When updating the manuscript, keep the cited
work's name, PolicyLint, unchanged.

## 7. Verification that behaviour and results are unchanged

| Check | Result |
|---|---|
| `npm test` (`node --test`) | 7/7 pass, 0 fail |
| `npm run lint` | "Project structure and JSON files are valid." |
| `python validation/regression_check.py` (SPEDIA replay in an isolated copy) | Table 3 reproduced exactly; `spedia_replay_summary.csv`, `spedia_replay_channels.csv`, `spedia_dataset_profile.csv` identical; `spedia_formal_findings.json` identical apart from `elapsed_ms` |
| SHA-256 of every file under `results/`, `examples/`, `data/` before vs. after | all identical except `data/ATTRIBUTION.md` (intended text edit) |
| CLI `analyze examples/sample-policy.json --format json` (first-match and most-restrictive), before vs. after | identical after removing `elapsed_ms` |
| CLI text report, before vs. after | only the heading line differs (`RuleScope-DLP Analysis Report`) |
| `generateBenchmarkPolicy(n, seed)` for n ∈ {50,100,250,500,1000}, seeds 1–10: rules, requirements, expected finding ids (name excluded), before vs. after | byte-identical |
| Validation outputs (`spedia_adapter_validation.py`, `manual_mapping_sample.py`, `scope_pool_reconciliation.py`, `checker_sensitivity_test.py`) re-run | all outputs byte-identical to the pre-rename files |
| `validation/output/regression_results.md` | rewritten by the regression run (Task 5); see note below |

**Note on `regression_results.md`:** running `regression_check.py` regenerates this report and
`validation/output/regression_rerun/`. The new report differs from the previous one only in
run-specific lines (run timestamp and test duration). Every compared count, and the "Table 3
reproduced exactly: yes" verdict, is the same. The previous byte-exact version was not kept.

No F1 value, runtime value, SPEDIA count, seed, Table 2/Table 3 value, controlled benchmark
result or validation finding was changed.

## 8. Final search (after the rename)

Case-insensitive search for `PolicyLint-DLP`, `policyLint-dlp`, `policylint-dlp`, excluding
`.git/` and `node_modules/`. Remaining occurrences:

| Location | Reason |
|---|---|
| `results/figures/fig2_runtime_scaling.svg`, `fig3_effectiveness.svg` | generated outputs, intentionally unchanged (§5) |
| `CHANGELOG.md` (Unreleased entry) | historical note recording the old name |
| `rename_audit.md` (this file) | audit record |
| `.git/config` (`origin` URL) | local remote URL; change after the GitHub rename (§9) |

## 9. Manual steps on GitHub (not performed)

1. Rename the repository on GitHub: Settings → General → Repository name:
   `policyLint-dlp` → `rulescope-dlp`. GitHub redirects the old URL, but the redirect breaks if a
   new repository is later created under the old name.
2. Update the local remote:

   ```bash
   git remote set-url origin https://github.com/fatihkaplanfk/rulescope-dlp.git
   ```

3. Update the repository description, topics and About-section website on GitHub if they
   mention PolicyLint-DLP.
4. Update any Zenodo/GitHub integration or release titles that use the old name. Existing DOIs
   keep their recorded metadata.
5. Old URLs to replace elsewhere: `https://github.com/fatihkaplanfk/policyLint-dlp`
   (manuscript Data Availability statement, cover letter, any README badge or link on other
   sites).
6. Outside the repository: `PolicyLint-DLP-v0.2.1-GitHub-Package.zip`, the manuscript `.tex`,
   `.docx` and `.pdf` files, the cover letter, the figure files and the anonymous-submission note
   still use the old name. They were not changed in this step.
