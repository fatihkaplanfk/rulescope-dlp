# External evaluation data

The trace-replay experiment uses the annotated English release of the SPEDIA
insider-threat dataset. The raw CSV is not redistributed in this repository.

- Record: https://zenodo.org/records/15525713
- Concept DOI: https://doi.org/10.5281/zenodo.15495572
- File: `logs_SPEDIA_annotated_en.csv`
- License: Creative Commons Attribution 4.0
- Expected size: 45,703,322 bytes
- Expected MD5: `e01e0baaf3b523a0b493fc9c52af2b1c`

Download and verify the exact file used in the paper:

```bash
python experiments/fetch_spedia.py
```

The downloader writes the file to `data/raw/`, which is intentionally ignored
by Git. Run the independent trace-replay experiment with:

```bash
npm run spedia
```

Policy decisions never use the SPEDIA `Anomaly` label, `Agent_name`, or `User`.
The label is consulted only after evaluation to stratify observed exposures.
This restriction prevents the instance-identity leakage present in the source
data from inflating results.

