#!/usr/bin/env python3
"""Mapping-focused manual-review sample for SAUCIS Reviewer 1, comment 3.

This sample complements the 200-record general sample produced by
spedia_adapter_validation.py and does not replace it. It targets the mappings
the reviewer questioned:
  A) email external-attachment scope,
  B) HTTP fixed cloud-domain list / CloudUpload proxy,
  C) removable-device connection scope,
  D) path/extension-based file classification.
There are 25 records per group. Selection uses source metadata and the
adapter's mapping outcome only. Anomaly, Agent_name and User are never read
for selection or written to the output. Records already present in the
general sample are excluded, so no record is reviewed twice.

Outputs (new files only; existing validation outputs are not touched):
  validation/output/manual_mapping_review.csv
  validation/output/manual_mapping_review_method.md

Usage
  python validation/manual_mapping_sample.py [--dataset PATH] [--seed 20261007]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spedia_adapter_validation as v  # noqa: E402  (shared helpers; its main() is not run)

PER_GROUP = 25
GROUPS = ["A_EMAIL", "B_HTTP_CLOUD", "C_REMOVABLE_DEVICE", "D_FILE"]
STREAM_BASE = 100  # RNG streams [seed, 100+k]; the general sample used [seed, 0..3]
RECOGNIZED_EXT = set(v.SPEC_FILE_TYPE)  # pdf docx xlsx csv zip txt
FILE_STRATA = [  # (code, description), 5 records each
    ("D1", "Path present, recognized extension, no sensitivity keyword"),
    ("D2", "Path present, unrecognized or missing extension (file_type OTHER), no sensitivity keyword"),
    ("D3", "Path present, sensitivity keyword matched (SensitiveFile)"),
    ("D4", "Path missing (Filename only), recognized extension"),
    ("D5", "Path missing (Filename only), .doc extension (file_type OTHER)"),
]


def file_stratum(row: dict, result: dict) -> str:
    d = result["ind"]["derived"]
    has_path = d["reference_field"] == "Path"
    ext = d["extension"]
    if has_path:
        if d["sensitivity_keyword"]:
            return "D3"
        return "D1" if ext in RECOGNIZED_EXT else "D2"
    if ext in RECOGNIZED_EXT:
        return "D4"
    if ext == "doc":
        return "D5"
    return ""  # Filename-only with other extensions (.jpg, .exe): not sampled


def draw(pool_ids: list[str], k: int, seed: int, stream: int) -> list[str]:
    ordered = sorted(pool_ids)
    if len(ordered) < k:
        raise RuntimeError(f"Pool too small ({len(ordered)}) for {k} records")
    rng = np.random.default_rng([seed, stream])
    return [ordered[i] for i in sorted(rng.choice(len(ordered), size=k, replace=False))]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=v.ROOT / "logs_SPEDIA_annotated_en.csv")
    parser.add_argument("--seed", type=int, default=v.DEFAULT_SEED)
    args = parser.parse_args()

    size, md5, _ = v.file_digest(args.dataset)
    if md5 != v.EXPECTED_MD5 or size != v.EXPECTED_SIZE:
        raise SystemExit(f"Dataset identity mismatch: size={size} md5={md5}")
    frame = pd.read_csv(args.dataset, low_memory=False)
    replay = frame[frame["Activity"].isin(v.CATEGORIES)]
    columns = v.ACTIVITY_COLUMNS + ["From"]
    rows = replay[columns].to_dict("records")
    anomalies = replay["Anomaly"].astype(int).tolist()  # given to the adapter only

    checked = {}
    for row, anomaly in zip(rows, anomalies):
        base = {k: row[k] for k in v.ACTIVITY_COLUMNS}
        checked[row["id"]] = (row, v.check_record(base, anomaly))

    # Exclude the general 200-record sample (same seed, same procedure).
    general = set(v.stratified_sample(frame, args.seed)["id"])

    pools: dict[str, list[str]] = {g: [] for g in GROUPS}
    file_pools: dict[str, list[str]] = {code: [] for code, _ in FILE_STRATA}
    cloud_by_host: dict[str, list[str]] = {}
    excluded_overlap = Counter()
    for rid, (row, result) in checked.items():
        scope = result["adapter_scope"]
        group = {"REQ_EMAIL_EXTERNAL_ATTACHMENT": "A_EMAIL", "REQ_CLOUD_TRANSFER": "B_HTTP_CLOUD",
                 "REQ_USB_CONNECT": "C_REMOVABLE_DEVICE"}.get(scope)
        if row["Activity"] == "file":
            group = "D_FILE"
        if group is None:
            continue
        if rid in general:
            excluded_overlap[group] += 1
            continue
        pools[group].append(rid)
        if group == "B_HTTP_CLOUD":
            cloud_by_host.setdefault(result["ind"]["derived"]["cloud_list_match"], []).append(rid)
        if group == "D_FILE" and (code := file_stratum(row, result)):
            file_pools[code].append(rid)

    selected: list[tuple[str, str, str]] = []  # (group, subgroup, id)
    selected += [("A_EMAIL", "A", rid) for rid in draw(pools["A_EMAIL"], PER_GROUP, args.seed, STREAM_BASE + 0)]
    # B: one record per matched cloud-list entry first, then the remainder at
    # random from the rest of the pool, so every matched entry is inspected.
    hosts = sorted(cloud_by_host)
    first = [draw(cloud_by_host[h], 1, args.seed, STREAM_BASE + 10 + i)[0] for i, h in enumerate(hosts)]
    rest = [rid for rid in pools["B_HTTP_CLOUD"] if rid not in set(first)]
    second = draw(rest, PER_GROUP - len(first), args.seed, STREAM_BASE + 1)
    selected += [("B_HTTP_CLOUD", "B-min1/" + checked[r][1]["ind"]["derived"]["cloud_list_match"], r) for r in first]
    selected += [("B_HTTP_CLOUD", "B-random", r) for r in second]
    selected += [("C_REMOVABLE_DEVICE", "C", rid)
                 for rid in draw(pools["C_REMOVABLE_DEVICE"], PER_GROUP, args.seed, STREAM_BASE + 2)]
    for i, (code, _) in enumerate(FILE_STRATA):
        selected += [("D_FILE", code, rid) for rid in draw(file_pools[code], PER_GROUP // len(FILE_STRATA),
                                                             args.seed, STREAM_BASE + 30 + i)]

    out_rows = []
    counters = {g: Counter() for g in GROUPS}
    numbering = Counter()
    for group, subgroup, rid in selected:
        row, result = checked[rid]
        numbering[group] += 1
        record = build_row(group, subgroup, numbering[group], row, result)
        out_rows.append(record)
        c = counters[group]
        c["reviewed"] += 1
        c["rule_consistent"] += record["rule_consistent"] == "yes"
        c["ambiguous"] += record["ambiguous"] == "yes"
        c["semantically_verified"] += record["semantically_verified"] == "true"
        for flag in filter(None, record["flags"].split(";")):
            c["flag:" + flag] += 1

    out_csv = v.OUTPUT / "manual_mapping_review.csv"
    with out_csv.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(out_rows[0]))
        writer.writeheader()
        writer.writerows(out_rows)

    pool_sizes = {g: len(p) for g, p in pools.items()}
    write_method(args.seed, md5, pool_sizes, excluded_overlap, file_pools, cloud_by_host, counters, checked)
    print(json.dumps({"rows": len(out_rows), "pool_sizes": pool_sizes,
                      "excluded_general_overlap": dict(excluded_overlap),
                      "file_strata_pools": {k: len(p) for k, p in file_pools.items()},
                      "cloud_hosts": {h: len(p) for h, p in cloud_by_host.items()},
                      "summary": {g: dict(c) for g, c in counters.items()}}, indent=2))
    return 0


def size_metadata(row: dict) -> str:
    parts = [f"{f}={v.text(row[f])}" for f in ("Size", "Size_before", "Size_after") if not v.missing(row[f])]
    return "; ".join(parts) if parts else "none (Size, Size_before, Size_after empty)"


def build_row(group: str, subgroup: str, n: int, row: dict, result: dict) -> dict:
    a, ind = result["adapter"], result["ind"]
    d, flags = ind["derived"], list(ind["flags"])
    sender_domain = v.text(row.get("From")).rsplit("@", 1)[-1].lower() if "@" in v.text(row.get("From")) else ""
    hostname_or_recipient = ""
    supports, verifiable, unverifiable = "", "", ""

    if row["Activity"] == "email":
        if sender_domain and sender_domain != v.SPEC_INTERNAL_DOMAIN:
            flags.append("SENDER_NOT_INTERNAL_DOMAIN")
        hostname_or_recipient = (f"To/Cc/Bcc domains: {d['recipient_domains']} "
                                 f"(external via: {d['external_fields'] or '-'}); sender domain: {sender_domain}")
        supports = (f"Action='{v.text(row['Action'])}'; recipient domains include non-{v.SPEC_INTERNAL_DOMAIN} "
                    f"domain(s) -> Untrusted; Attachments={v.text(row['Attachments'])} (>0) -> Attachment")
        verifiable = "message sent; recipient domains; external recipient (under the dtaa.com-internal assumption); attachment count"
        unverifiable = ("attachment content and sensitivity (Restricted is a research label); attachment file names/types; "
                        "whether dtaa.com is the only internal domain; sending device (Managed assumed)")
    elif row["Activity"] == "http":
        hostname_or_recipient = d["host"]
        supports = (f"host '{d['host']}' matches fixed cloud-list entry '{d['cloud_list_match']}' "
                    "-> CloudUpload/CloudService/Confidential (proxy)")
        verifiable = "URL accessed; hostname; membership of the fixed cloud-domain list"
        unverifiable = ("file upload (no HTTP method, request body size, transferred bytes or upload indicator; "
                        f"Action='{v.text(row['Action'])}'); data sensitivity (Confidential is a research label); "
                        "destination trust (Untrusted assumed); size (size_mb=0 because no size field exists)")
    elif row["Activity"] == "device":
        supports = f"Action='{v.text(row['Action'])}' -> DeviceConnect (USB scope)"
        verifiable = "device connect event; timestamp"
        unverifiable = ("device management status (Unmanaged is assumed for every device); device type "
                        "(removable storage vs other USB); data written to the device; destination trust (assumed)")
    else:
        hostname_or_recipient = ""
        ref = d["reference_field"]
        keyword = d["sensitivity_keyword"]
        supports = (f"{ref}='{d['file_reference']}'; extension '{d['extension'] or '(none)'}' -> file_type "
                    f"{a['file_type']}; " + (f"path keyword '{keyword}' -> SensitiveFile/Confidential"
                                               if keyword else ("no path keyword -> FileOperation/Internal" if ref == "Path"
                                                                else "no Path field: sensitivity rule not applicable -> FileOperation/Internal")))
        verifiable = f"file action ({v.text(row['Action'])}); {ref.lower()}; extension"
        unverifiable = ("file content sensitivity (classification is a path-keyword/default heuristic); "
                        "true file format (extension only, no magic bytes)"
                        + ("; directory location (Path missing)" if ref == "Filename" else ""))

    ambiguous = [f for f in flags if f in v.AMBIGUITY_FLAGS or f == "SENDER_NOT_INTERNAL_DOMAIN"]
    device_meta = ""
    if row["Activity"] == "device":
        device_meta = (f"Action={v.text(row['Action'])}; decoder={v.text(row['Decoder_name'])}; "
                       "no device id, vendor, serial, bus type or management field in source")
    return {
        "review_id": f"MMR-{group[0]}{n:02d}",
        "group": group,
        "subgroup": subgroup,
        "source_record_id": row["id"],
        "source_timestamp": v.text(row["Timestamp"]),
        "source_activity_type": v.text(row["Activity"]),
        "source_action": v.text(row["Action"]),
        "source_hostname_or_recipient": hostname_or_recipient,
        "source_url": v.text(row["Url"]),
        "source_recipients_raw": "; ".join(f"{f}={v.text(row[f])}" for f in ("To", "Cc", "Bcc") if not v.missing(row[f])),
        "source_attachments": v.text(row["Attachments"]),
        "source_filename": v.text(row["Filename"]),
        "source_path": v.text(row["Path"]),
        "source_size_metadata": size_metadata(row),
        "source_device_metadata": device_meta,
        "adapter_channel": a["channel"],
        "adapter_content_type": a["content_type"],
        "adapter_data_classification": a["data_classification"],
        "adapter_destination_trust": a["destination_trust"],
        "adapter_device_trust": a["device_trust"],
        "adapter_file_type": a["file_type"],
        "adapter_size_mb": a["size_mb"],
        "protection_scope": result["adapter_scope"] or "none",
        "mapping_rule": ind["rule"],
        "rule_consistent": "yes" if not result["mismatches"] else "no",
        "rule_consistency_mismatch_fields": ";".join(result["mismatches"]),
        "ambiguous": "yes" if ambiguous else "no",
        "ambiguity_reasons": ";".join(ambiguous),
        "source_metadata_supports_mapping": supports,
        "semantically_verified": "false",
        "semantic_claim_verifiable": "verifiable from source: " + verifiable,
        "semantic_claim_not_verifiable": unverifiable,
        "flags": ";".join(flags),
        "reviewer_notes": "",
        "human_review": "",
    }


def write_method(seed, md5, pool_sizes, overlap, file_pools, cloud_by_host, counters, checked) -> None:
    label = {"A_EMAIL": "A) Email", "B_HTTP_CLOUD": "B) HTTP / cloud", "C_REMOVABLE_DEVICE": "C) Removable device",
             "D_FILE": "D) File"}
    in_scope_email = [r for r, res in checked.values() if res["adapter_scope"] == "REQ_EMAIL_EXTERNAL_ATTACHMENT"]
    ext_sender = sum(1 for r in in_scope_email if "@" in v.text(r.get("From"))
                     and v.text(r["From"]).rsplit("@", 1)[1].lower() != v.SPEC_INTERNAL_DOMAIN)
    L = [
        "# Mapping-focused manual review sample — method",
        "",
        "Generated by `validation/manual_mapping_sample.py`. It complements the 200-record general sample "
        "(`review_sample.csv`, `sampling_method.md`), which is unchanged. **No manual review has been "
        "performed.** The `human_review` and `reviewer_notes` columns of `manual_mapping_review.csv` are "
        "empty, and every count below is an automatic pre-analysis.",
        "",
        "## Command and seed",
        "",
        "```bash",
        f"python validation/manual_mapping_sample.py --seed {seed}",
        "```",
        "",
        f"- Seed: `{seed}`. Each draw uses NumPy `default_rng([seed, stream])` with fixed stream numbers "
        "(email 100, cloud 101 plus 110–114, device 102, file strata 130–134). These streams are distinct "
        "from the general sample's streams 0–3.",
        f"- Dataset MD5 verified before sampling: `{md5}`.",
        "- Within every pool, records are ordered by source `id` before drawing, so the result does not "
        "depend on file row order.",
        "- Selection variables: `Activity`, `Action`, source metadata (`To/Cc/Bcc`, `Attachments`, `Url`, "
        "`Path`, `Filename`) and the adapter's mapping outcome. **`Anomaly`, `Agent_name` and `User` are "
        "not used and are not written to the CSV.**",
        "- Records in the 200-record general sample are excluded, so no record is reviewed twice.",
        "",
        "## Sampling strategy and group sizes",
        "",
        "| Group | Selection rule | Eligible pool (after exclusion) | Excluded (in general sample) | Sampled |",
        "|---|---|---:|---:|---:|",
        f"| A) Email | adapter scope = REQ_EMAIL_EXTERNAL_ATTACHMENT (external recipient and Attachments > 0) | "
        f"{pool_sizes['A_EMAIL']:,} | {overlap['A_EMAIL']} | {counters['A_EMAIL']['reviewed']} |",
        f"| B) HTTP / cloud | adapter scope = REQ_CLOUD_TRANSFER (host on the fixed cloud list -> CloudUpload) | "
        f"{pool_sizes['B_HTTP_CLOUD']:,} | {overlap['B_HTTP_CLOUD']} | {counters['B_HTTP_CLOUD']['reviewed']} |",
        f"| C) Removable device | adapter scope = REQ_USB_CONNECT (Action = Connect) | "
        f"{pool_sizes['C_REMOVABLE_DEVICE']:,} | {overlap['C_REMOVABLE_DEVICE']} | "
        f"{counters['C_REMOVABLE_DEVICE']['reviewed']} |",
        f"| D) File | all file records, stratified by path/extension behaviour (below) | "
        f"{pool_sizes['D_FILE']:,} | {overlap['D_FILE']} | {counters['D_FILE']['reviewed']} |",
        "",
        "Groups A–C are simple random samples from the in-scope records behind Table 3. Group B first "
        "takes one record for each matched cloud-list entry, then draws the remainder at random, so that "
        "every list entry seen in the data is inspected. Matched entries (pool sizes): "
        f"{ {h: len(p) for h, p in sorted(cloud_by_host.items())} }.",
        "",
        "Group D strata (5 records each):",
        "",
        "| Stratum | Definition | Pool |",
        "|---|---|---:|",
    ]
    for code, desc in FILE_STRATA:
        L.append(f"| {code} | {desc} | {len(file_pools[code]):,} |")
    L += [
        "",
        "File records that have only a Filename with another extension (`.jpg`, `.exe`) are not sampled. "
        "They follow the same rule as D5.",
        "",
        "## Automatic pre-analysis",
        "",
        "Two questions are answered separately for each record:",
        "",
        "1. **Rule-consistent** (`rule_consistent`): does the source metadata yield the normalized value "
        "under the documented adapter rule? This is checked with the independent checker in "
        "`spedia_adapter_validation.py`.",
        "2. **Semantically verified** (`semantically_verified`): can the SPEDIA source establish the "
        "real-world security meaning of the mapped event, for example that sensitive data actually left "
        "through that channel? The columns `semantic_claim_verifiable` and `semantic_claim_not_verifiable` "
        "list the parts of the claim the source can and cannot establish.",
        "",
        "| Group | Records | Rule-consistent | Ambiguous (needs judgement) | Semantically verified |",
        "|---|---:|---:|---:|---:|",
    ]
    for g in GROUPS:
        c = counters[g]
        L.append(f"| {label[g]} | {c['reviewed']} | {c['rule_consistent']} | {c['ambiguous']} | "
                 f"{c['semantically_verified']} |")
    L += ["", "Flag counts in the sample:", ""]
    for g in GROUPS:
        flags = {k[5:]: n for k, n in counters[g].items() if k.startswith("flag:")}
        L.append(f"- {label[g]}: {flags or 'none'}")
    L += [
        "",
        "`Semantically verified` is `false` for every record. This is not a review outcome. Each mapped "
        "DLP claim contains a component that SPEDIA does not record (content sensitivity, upload, or "
        "device trust), as listed below.",
        "",
        "## What the source can and cannot establish",
        "",
        "| Group | Verifiable from SPEDIA metadata | Not verifiable from SPEDIA |",
        "|---|---|---|",
        "| Email | `Action = Email sent`; recipient domains; whether a recipient is outside `dtaa.com`; "
        "attachment count | attachment content and sensitivity (`Restricted`); attachment names and types; "
        "that `dtaa.com` is the only internal domain; sending device (`Managed` assumed) |",
        "| HTTP / cloud | URL accessed; hostname; membership of the fixed list | any upload (no method, "
        "byte count or upload indicator); data sensitivity (`Confidential`); destination trust; size |",
        "| Removable device | connect vs. disconnect action; timestamp | management status (`Unmanaged` is "
        "assumed); device class; whether data was written |",
        "| File | file action; path or filename; extension | content sensitivity; true format (extension "
        "only); directory location when Path is missing |",
        "",
        "## Limitations to state explicitly",
        "",
        "- **HTTP upload proxy.** Every SPEDIA HTTP record has `Action = URL accedida` (\"URL accessed\") "
        "and no HTTP method, request size, transferred bytes or uploaded object. A host on the cloud "
        "list is therefore evidence of *access to a file-transfer service*, never of a file upload. "
        "`CloudUpload` is a metadata proxy, and group B records must not be counted as verified uploads.",
        "- **Fixed cloud-domain list.** The 13-domain list was fixed before the replay and is incomplete. "
        "The full-population report already shows file-hosting hosts outside the list (e.g. "
        "`megaupload.com`, `filesonic.com`, `fileserve.com`) mapped to `Web`. In-scope cloud counts are "
        "therefore a lower bound for this proxy definition. List membership also says nothing about "
        "what the user did on the service.",
        "- **Device-trust assumption.** SPEDIA device records contain only the connect or disconnect "
        "action. `device_trust = Unmanaged` is assigned to every device by assumption. It is not a "
        "verified device property and must not be described as one.",
        "- **Path/extension classification.** Sensitivity is inferred from path keywords only, and "
        "`file_type` from the extension only. `File accessed` records have no Path, so the sensitivity "
        "rule cannot fire for them (stratum D4/D5). Legacy `.doc` files fall outside the declared "
        "`file_type` domain and become `OTHER`. No file content is available. File mappings do not "
        "enter any declared requirement, so they do not affect Table 3.",
        f"- **Email sender domain.** {ext_sender:,} of the {len(in_scope_email):,} in-scope email records "
        f"have a sender address outside `{v.SPEC_INTERNAL_DOMAIN}`. The source labels them `Email sent`, "
        "but they may describe personal webmail rather than traffic through the corporate gateway. The "
        "adapter does not consider the sender. These records are flagged `SENDER_NOT_INTERNAL_DOMAIN` "
        "for human judgement. This observation was not part of the earlier report.",
        "- **Shared specification.** Rule consistency is checked against the same written specification "
        "that the adapter implements. It confirms faithful implementation, not that the mapping is the "
        "right DLP interpretation. That is the purpose of the human review.",
        "",
        "## Reviewer instructions",
        "",
        "For each row, compare `source_*` with `adapter_*` and `mapping_rule`. Record in `human_review` "
        "one of `consistent`, `inconsistent` or `ambiguous`. In `reviewer_notes`, record whether the "
        "source supports the *security meaning* (e.g. \"external recipient confirmed; content unknown\"). "
        "Ideally, two reviewers work independently and their agreement is reported.",
        "",
        "## Summary table (to be completed after human review)",
        "",
        "| Category | Reviewed | Mapping-rule consistent | Ambiguous | Source semantics independently verifiable |",
        "|---|---:|---:|---:|---:|",
        "| Email | | | | |",
        "| HTTP / cloud | | | | |",
        "| Removable device | | | | |",
        "| File | | | | |",
        "| **Total** | | | | |",
        "",
        "## Draft methodology text (no review results)",
        "",
        "> In addition to a 200-record stratified sample drawn across the four activity categories, a "
        "second, mapping-focused sample was drawn to examine the adapter decisions that determine the "
        "declared protection scopes. Using a fixed seed (20261007) and excluding records already in the "
        "first sample, 25 records were selected from each of four groups. The first group consists of "
        "email records mapped to external recipients with attachments. The second consists of HTTP "
        "records whose hostname matched the fixed cloud-transfer domain list and was therefore "
        "normalized to the CloudUpload proxy; one record per matched list entry was included. The "
        "third consists of removable-device connection events. The fourth consists of file records, "
        "stratified by the presence of a path, recognized versus unrecognized extensions, "
        "keyword-based path sensitivity and filename-only legacy `.doc` records. Selection did not use "
        "the Anomaly, Agent_name or User fields. For each record, the review sheet lists the source "
        "metadata, the normalized attributes and the applied mapping rule, and it distinguishes two "
        "questions. The first is whether the normalized value follows from the source metadata under "
        "the documented rule (rule consistency). The second is whether the source data can establish "
        "the security meaning of the mapped event (semantic verifiability). The latter is not "
        "established for any group by construction: SPEDIA HTTP records contain no request method, "
        "transferred bytes or upload indicator, so a cloud-domain match denotes access to the service "
        "rather than a verified upload; device records carry no management status, so the Unmanaged "
        "attribute is an assumption; and no category provides content sensitivity. The results of the "
        "manual review are reported separately from these automatically derived properties.",
        "",
    ]
    (v.OUTPUT / "manual_mapping_review_method.md").write_text("\n".join(L), "utf-8")


if __name__ == "__main__":
    sys.exit(main())
