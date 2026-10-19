#!/usr/bin/env python3
"""Show that the independent checker detects adapter faults.

A checker that reports 0 disagreements is only informative if it can report
disagreements. This script injects known faults into the adapter *in memory*
(monkeypatching module constants or wrapping normalize_event) and confirms
that the checker flags exactly the affected records. No file is modified.

Usage
  python validation/checker_sensitivity_test.py [--dataset PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spedia_adapter_validation as v  # noqa: E402
import prepare_spedia as adapter  # noqa: E402  (already on sys.path via v)


def run(rows, anomalies) -> int:
    return sum(1 for row, a in zip(rows, anomalies) if v.check_record(row, a)["mismatches"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=v.ROOT / "logs_SPEDIA_annotated_en.csv")
    args = parser.parse_args()
    frame = pd.read_csv(args.dataset, low_memory=False)
    replay = frame[frame["Activity"].isin(v.CATEGORIES)]
    rows = replay[v.ACTIVITY_COLUMNS].to_dict("records")
    anomalies = replay["Anomaly"].astype(int).tolist()

    baseline = run(rows, anomalies)
    results = [("baseline (unchanged adapter)", 0, baseline)]

    original_normalize = v.normalize_event

    # Fault 1: drop a cloud domain from the adapter list.
    saved = adapter.CLOUD_TRANSFER_DOMAINS
    adapter.CLOUD_TRANSFER_DOMAINS = saved - {"mediafire.com"}
    expected = sum(1 for r in rows if r["Activity"] == "http" and v.on_cloud_list(v.url_host(r["Url"])) == "mediafire.com")
    results.append(("cloud list without mediafire.com", expected, run(rows, anomalies)))
    adapter.CLOUD_TRANSFER_DOMAINS = saved

    # Fault 2: wrong internal email domain.
    saved = adapter.INTERNAL_EMAIL_DOMAIN
    adapter.INTERNAL_EMAIL_DOMAIN = "dtaa.org"
    expected = sum(1 for r in rows if r["Activity"] == "email"
                   and any(d == "dtaa.com" for f in ("To", "Cc", "Bcc") for d in v.recipient_domains(r[f]))
                   and not any(d != "dtaa.com" for f in ("To", "Cc", "Bcc") for d in v.recipient_domains(r[f])))
    results.append(("internal domain set to dtaa.org", expected, run(rows, anomalies)))
    adapter.INTERNAL_EMAIL_DOMAIN = saved

    # Fault 3: sensitivity regex loses the 'backup' keyword.
    saved = adapter.SENSITIVE_PATH
    adapter.SENSITIVE_PATH = re.compile(saved.pattern.replace("|backup", ""), re.IGNORECASE)
    expected = sum(1 for r in rows if r["Activity"] == "file" and r["Path"] == r["Path"]
                   and v.sensitive_keyword(str(r["Path"])) and not adapter.SENSITIVE_PATH.search(str(r["Path"])))
    results.append(("sensitivity regex without 'backup'", expected, run(rows, anomalies)))
    adapter.SENSITIVE_PATH = saved

    # Fault 4: adapter treats .doc as DOCX.
    saved = adapter.FILE_TYPES
    adapter.FILE_TYPES = {**saved, ".doc": "DOCX"}
    expected = sum(1 for r in rows if v.extension(v.text(r["Filename"]) or v.text(r["Path"])) == "doc")
    results.append(("file-type map adds .doc -> DOCX", expected, run(rows, anomalies)))
    adapter.FILE_TYPES = saved

    # Fault 5: device disconnect mapped as connect.
    def flipped(row):
        event = original_normalize(row)
        if row["Activity"] == "device":
            event["content_type"] = "DeviceConnect"
        return event
    v.normalize_event = flipped
    expected = sum(1 for r in rows if r["Activity"] == "device" and str(r["Action"]).strip().lower() == "disconnect")
    results.append(("device disconnect mapped to DeviceConnect", expected, run(rows, anomalies)))
    v.normalize_event = original_normalize

    # Fault 6: attachment presence ignored.
    def no_attachment(row):
        event = original_normalize(row)
        if row["Activity"] == "email" and event["content_type"] == "Attachment":
            event["content_type"] = "Message"
        return event
    v.normalize_event = no_attachment
    expected = sum(1 for r in rows if r["Activity"] == "email" and float(r["Attachments"]) > 0)
    results.append(("email attachment ignored", expected, run(rows, anomalies)))
    v.normalize_event = original_normalize

    failed = False
    print("| Injected fault | Expected affected records | Checker mismatches | Detected |")
    print("|---|---:|---:|---|")
    for name, expected, observed in results:
        ok = observed == expected and (expected > 0 or name.startswith("baseline"))
        failed |= not ok
        print(f"| {name} | {expected:,} | {observed:,} | {'yes' if ok else 'NO'} |")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
