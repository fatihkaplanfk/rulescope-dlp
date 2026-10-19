# SPEDIA-to-DLP adapter validation

This folder answers SAUCIS Reviewer 1, comment 3: the adapter's heuristic
mappings had not been checked against a manual sample of source records.

Nothing outside `validation/` is modified. The adapter
(`experiments/prepare_spedia.py`), the policy (`experiments/spedia-policy.js`),
the analyzer and the committed `results/` stay as they are.

## Commands

```bash
npm ci
python validation/spedia_adapter_validation.py --seed 20261007
python validation/checker_sensitivity_test.py > validation/output/checker_sensitivity.md
python validation/regression_check.py
```

Requirements: Python 3.11+ with pandas and numpy; Node.js 20+.
Run time is about 10 s for each Python step and under 1 min for the
regression step.

- **Dataset:** `logs_SPEDIA_annotated_en.csv`, MD5 `e01e0baaf3b523a0b493fc9c52af2b1c`, 45,703,322 bytes. Pass `--dataset PATH` if the file is not in the repository root or in `data/raw/`.
- **Seed:** `20261007`. Sampling uses NumPy `default_rng([seed, stratum_index])`.

## Outputs (`validation/output/`)

| File | Content |
|---|---|
| `sampling_method.md` | Sampling design, seed, stratum sizes, reproducibility |
| `review_sample.csv` | 200 records with source metadata, derived values, normalized values, mapping rule, automatic check, evidence status, flags, and **empty** `human_review_*` columns |
| `adapter_validation_report.md` | Integrity checks, the full-population independent check, category findings, flags, the manual-review summary table (empty) and limitations |
| `automatic_checks.json` | Machine-readable form of all automatic results, including the 200 sampled ids |
| `checker_sensitivity.md` | Fault-injection test showing that the independent checker detects adapter errors |
| `regression_results.md` | `node --test`, a replay in an isolated copy, and a comparison with Table 3 and the committed `results/` |
| `regression_rerun/` | Fresh replay outputs, kept separately for audit |

### Second sample: mapping-focused review (100 records)

```bash
python validation/manual_mapping_sample.py --seed 20261007
```

This adds two new files and leaves the outputs above unchanged.

| File | Content |
|---|---|
| `manual_mapping_review.csv` | 25 records each from email external-attachment, HTTP cloud proxy, removable-device connect and file path/extension strata. Includes `rule_consistent`, `semantically_verified` and empty `human_review`/`reviewer_notes` columns |
| `manual_mapping_review_method.md` | Sampling strategy, pools, automatic pre-analysis, limitations, the summary table to fill in and draft methodology text |

## Manual review

Open `review_sample.csv` (UTF-8 with BOM, so it opens in Excel). For each
row, fill in the following columns:

- `human_review_mapping_correct`: `yes` / `no` / `cannot_determine`
- `human_review_scope_correct`: `yes` / `no` / `cannot_determine`
- `human_review_supports_real_transfer`: `yes` / `no` / `cannot_determine`
- `human_review_notes`, `reviewer`, `review_date`

The sheet does not contain `Anomaly`, `Agent_name` or `User`, so the review
is blind to labels and identities. After the review, fill in table 5 in
`adapter_validation_report.md`. Ideally, two reviewers work independently
and their agreement is reported.

## Suggested Materials and Methods paragraph (no manual results included)

> **Adapter validation.** Because the SPEDIA-to-DLP adapter relies on
> deterministic metadata mappings rather than source labels, its output was
> validated separately from the replay. The integrity of the dataset file was
> first confirmed against the published size and MD5 checksum, and the record
> counts of the four DLP-relevant activity categories were confirmed to sum to
> the 56,737 replayed records. An independent checker was then implemented. It
> derives the expected normalized attributes and requirement scope of every
> record directly from the source metadata (recipient domains and attachment
> counts, URL hostnames, file paths and extensions, and device actions),
> following the published mapping rules but using separately written parsing
> code. Across all 56,737 records, the checker and the adapter agreed on every
> compared attribute. Both assigned 1,851 email, 445 cloud-proxy and 2,178
> removable-device events to the declared protection scopes, matching the
> 4,474 in-scope events in Table 3. To confirm that this agreement is
> informative, six faults were injected into the adapter in memory, and the
> checker detected each affected record. The checker also flags attributes
> that the source data cannot substantiate: no HTTP record contains an HTTP
> method, byte count or object name, so a cloud-domain match indicates access
> to the service rather than an observed upload; device trust is an assumption
> because SPEDIA provides no device identifier; and HTTP and device records
> lack size metadata, so the zero-size condition of the cloud-conflict
> mutation reflects missing metadata rather than observed zero-byte transfers.
> A stratified sample of 200 records (50 per activity category; fixed seed
> 20261007; selection independent of the Anomaly, Agent_name and User fields)
> was exported with its source metadata, normalized values and applied mapping
> rule for manual review by the authors. Because the checker and the adapter
> share the same mapping specification, including the internal email domain,
> the cloud-domain list and the path-sensitivity keywords, their agreement
> confirms that the specification is implemented faithfully. It does not show
> that the specification is the correct DLP interpretation of each record.
> Finally, the replay was re-executed in an isolated copy of the artifact and
> reproduced every count in Table 3.

Add the following sentence **only after** the manual review is complete,
using the real numbers:

> *Manual review of the 200 sampled records found the mapping correct for
> [N] records, incorrect for [N] and undeterminable from the source metadata
> for [N]; [details of any disagreements].*

## Formal-model fixes (Reviewer 2)

```bash
npm test
python validation/formal_model_fixes/regression.py
```

- `formal_model_fixes/query_stats.mjs`: SAT/UNSAT/UNKNOWN census and completeness for the 50
  controlled policies, the 5 SPEDIA variants and the example policy.
- `formal_model_fixes/regression.py`: runs the benchmark and the SPEDIA replay in isolated copies
  (current code and the previous code from git HEAD). It compares finding ids, F1 and Table 3
  with `results/`, and writes `output/formal_model_fixes/regression_report.md`. `results/` is
  not written.

The differential test (`test/differential.test.js`) compares symbolic and concrete decisions on
every event of small, fully enumerated event spaces. Both implementations share the schema,
normalisation, severity order and rule ordering, so agreement does not independently validate
those shared definitions.
