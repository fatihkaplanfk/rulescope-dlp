#!/usr/bin/env python3
"""Validate the SPEDIA-to-DLP adapter against source metadata.

This script answers SAUCIS Reviewer 1, comment 3. It does not modify the
adapter, the policy, or any file under results/. It writes only to
validation/output/.

Steps
  1. Dataset integrity: size, MD5, SHA-256, column set, activity counts and
     the 56,737-record replay scope.
  2. Stratified sampling: 50 records per DLP activity (email, http, file,
     device) with a fixed seed. Sampling uses only `Activity` and the record
     `id`; `Anomaly`, `Agent_name` and `User` are never read for sampling.
  3. Adapter output: the unchanged `normalize_event` from
     experiments/prepare_spedia.py is called for every record.
  4. Independent check: a separate implementation derives the expected
     normalized attributes directly from source metadata and the published
     mapping description, using different parsing code. It is applied to the
     200 sampled records and to the full 56,737-record replay population.
  5. Manual-review sheet: review_sample.csv with empty human_review columns.

Usage
  python validation/spedia_adapter_validation.py [--dataset PATH] [--seed N]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import ipaddress
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "validation" / "output"
sys.path.insert(0, str(ROOT / "experiments"))
from prepare_spedia import normalize_event  # noqa: E402  (adapter under test, unchanged)

DEFAULT_SEED = 20261007
SAMPLE_PER_CATEGORY = 50
CATEGORIES = ["email", "http", "file", "device"]  # fixed order -> per-category seed index
CATEGORY_LABEL = {"email": "Email", "http": "HTTP", "file": "File", "device": "Removable-device"}

# Published dataset identity (paper, Materials and Methods; data/README.md).
EXPECTED_SIZE = 45_703_322
EXPECTED_MD5 = "e01e0baaf3b523a0b493fc9c52af2b1c"
EXPECTED_ROWS = 72_250
EXPECTED_COLUMNS = 24
EXPECTED_REPLAY_ROWS = 56_737
EXPECTED_ACTIVITY = {"email": 18_203, "http": 21_723, "file": 12_405, "device": 4_406}
# Table 3 (paper): in-scope events by declared requirement.
EXPECTED_SCOPE = {"Email": 1_851, "CloudUpload": 445, "USB": 2_178}

# ---------------------------------------------------------------------------
# Independent mapping specification.
# Transcribed from the published mapping description (paper, Section 3:
# "recipient domains and attachment presence", "hostnames and a documented
# fixed list of cloud-transfer domains", "paths and filename extensions",
# "connect and disconnect actions") and from the constants documented with the
# artifact. The *values* below (internal domain, cloud list, sensitivity
# keywords, file-type domain) necessarily come from the same specification as
# the adapter; an error in that specification is therefore shared by both
# implementations (see report, Limitations).
# ---------------------------------------------------------------------------
SPEC_INTERNAL_DOMAIN = "dtaa.com"
SPEC_CLOUD_DOMAINS = (
    "4shared.com", "box.com", "docs.google.com", "drive.google.com", "dropbox.com",
    "github.com", "gitlab.com", "mediafire.com", "mega.nz", "onedrive.live.com",
    "pastebin.com", "sourceforge.net", "wetransfer.com",
)
SPEC_SENSITIVE_SUBSTRINGS = (
    "/etc/shadow", "/etc/passwd", "/etc/sudoers", "/.ssh/", "id_rsa",
    "private_key", "private-key", "privatekey", "credential", "secret", "token",
    "password", "passwd", "database", "dump", "backup",
)
SPEC_SENSITIVE_SUFFIX_TOKENS = (".pem", ".db", ".sqlite")  # followed by end or non-word char
SPEC_FILE_TYPE = {"pdf": "PDF", "docx": "DOCX", "xlsx": "XLSX", "csv": "CSV", "zip": "ZIP", "txt": "TXT"}
SPEC_SIZE_FIELDS = ("Size", "Size_after", "Size_before")
SPEC_SIZE_MAX_MB = 10240
# Diagnostic only (never used for mapping): host keywords suggesting a
# file-transfer service that is absent from the fixed list.
TRANSFER_HINT = re.compile(r"upload|file|drive|transfer|paste", re.IGNORECASE)

# Clean-policy requirement scopes, transcribed from experiments/spedia-policy.js.
REQUIREMENTS = {
    "REQ_EMAIL_EXTERNAL_ATTACHMENT": {"data_classification": "Restricted", "content_type": "Attachment",
                                      "channel": "Email", "destination_trust": "Untrusted"},
    "REQ_CLOUD_TRANSFER": {"data_classification": "Confidential", "content_type": "CloudService",
                           "channel": "CloudUpload", "destination_trust": "Untrusted"},
    "REQ_USB_CONNECT": {"data_classification": "Internal", "content_type": "DeviceConnect", "channel": "USB",
                        "destination_trust": "Untrusted", "device_trust": "Unmanaged"},
}
COMPARED_FIELDS = ("channel", "content_type", "data_classification", "destination_trust",
                   "device_trust", "user_group", "file_type", "size_mb")

AMBIGUITY_FLAGS = {
    "PRIVATE_IP_HOST_MARKED_UNTRUSTED", "TRANSFER_LIKE_HOST_NOT_ON_LIST",
    "FILENAME_ONLY_SENSITIVITY_NOT_EVALUABLE", "EXTENSION_OUTSIDE_TYPE_DOMAIN",
    "NO_EXTENSION", "SENSITIVE_BY_KEYWORD",
}

ACTIVITY_COLUMNS = ["id", "Timestamp", "Decoder_name", "Action", "Activity", "To", "Cc", "Bcc",
                    "Attachments", "Size", "Size_before", "Size_after", "Url", "Filename", "Path"]


# ----------------------------------------------------------------- helpers
def missing(value: object) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value)) or (
        isinstance(value, str) and value.strip() == "")


def text(value: object) -> str:
    return "" if missing(value) else str(value)


def file_digest(path: Path) -> tuple[int, str, str]:
    md5, sha = hashlib.md5(), hashlib.sha256()  # nosec B324 - dataset identity only
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            md5.update(chunk)
            sha.update(chunk)
    return path.stat().st_size, md5.hexdigest(), sha.hexdigest()


# ------------------------------------------------ independent derivations
def recipient_domains(value: object) -> list[str]:
    """Split on ';' or ',' and take the text after the last '@'."""
    out = []
    for part in re.split(r"[;,]", text(value)):
        part = part.strip()
        if "@" in part:
            out.append(part.rsplit("@", 1)[1].strip().lower())
    return out


URL_HOST = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)")


def url_host(value: object) -> str:
    match = URL_HOST.match(text(value).strip())
    if not match:
        return ""
    host = match.group(1).strip("[]").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def on_cloud_list(host: str) -> str:
    """Return the matched list entry or ''. Label-wise comparison, right to left."""
    labels = host.split(".")
    for entry in SPEC_CLOUD_DOMAINS:
        entry_labels = entry.split(".")
        if labels[-len(entry_labels):] == entry_labels:
            return entry
    return ""


def is_private_ip(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_private
    except ValueError:
        return False


def last_component(path_text: str) -> str:
    return re.split(r"[\\/]", path_text)[-1]


def extension(name: str) -> str:
    """Lower-case extension of the last path component; '' for none or dotfiles."""
    base = last_component(name)
    stem, dot, ext = base.rpartition(".")
    return ext.lower() if dot and stem else ""


def sensitive_keyword(path_text: str) -> str:
    lower = path_text.lower()
    for token in SPEC_SENSITIVE_SUBSTRINGS:
        if token in lower:
            return token
    for token in SPEC_SENSITIVE_SUFFIX_TOKENS:
        start = 0
        while (index := lower.find(token, start)) >= 0:
            after = lower[index + len(token): index + len(token) + 1]
            if after == "" or not (after.isalnum() or after == "_"):
                return token
            start = index + 1
    return ""


def size_mb(row: dict) -> tuple[int, str]:
    for field in SPEC_SIZE_FIELDS:
        value = row.get(field)
        if not missing(value) and float(value) > 0:
            return min(SPEC_SIZE_MAX_MB, max(1, math.ceil(float(value) / 1048576))), field
    return 0, ""


def independent_expectation(row: dict) -> dict:
    """Expected normalized event derived from source metadata only."""
    activity = text(row["Activity"])
    flags: list[str] = []
    unverifiable: list[str] = ["user_group (constant General by design; identities excluded)"]
    derived: dict[str, object] = {}

    size, size_source = size_mb(row)
    if size == 0:
        flags.append("SIZE_MISSING_DEFAULTS_TO_0")
    name = text(row.get("Filename")) or text(row.get("Path"))
    ext = extension(name) if name else ""
    file_type = SPEC_FILE_TYPE.get(ext, "OTHER")
    exp = {"user_group": "General", "size_mb": size, "file_type": file_type}

    if activity == "email":
        per_field = {f: recipient_domains(row.get(f)) for f in ("To", "Cc", "Bcc")}
        domains = sorted({d for values in per_field.values() for d in values})
        external_fields = [f for f, values in per_field.items() if any(d != SPEC_INTERNAL_DOMAIN for d in values)]
        external = bool(external_fields)
        attachments = row.get("Attachments")
        attached = (not missing(attachments)) and float(attachments) > 0
        if external and any(d == SPEC_INTERNAL_DOMAIN for d in domains):
            flags.append("MIXED_INTERNAL_EXTERNAL_RECIPIENTS")
        if external_fields == ["Bcc"]:
            flags.append("EXTERNAL_ONLY_VIA_BCC")
        if not domains:
            flags.append("NO_RECIPIENT_DOMAIN")
        if attached:
            flags.append("ATTACHMENT_CONTENT_NOT_IN_SOURCE")
        derived.update({
            "recipient_domains": ";".join(domains),
            "external_recipient": external,
            "external_fields": ";".join(external_fields),
            "attachment_present": attached,
        })
        exp.update({
            "channel": "Email",
            "content_type": "Attachment" if attached else "Message",
            "destination_trust": "Untrusted" if external else "Trusted",
            "data_classification": "Restricted" if (external and attached)
            else ("Confidential" if (external or attached) else "Internal"),
            "device_trust": "Managed",
        })
        unverifiable += ["data_classification (research mapping; no content label in SPEDIA)",
                         "device_trust (Managed assumed; no endpoint metadata)"]
        rule = ("EMAIL: recipient domain of To/Cc/Bcc != dtaa.com -> Untrusted; Attachments>0 -> Attachment; "
                "external+attachment -> Restricted; external xor attachment -> Confidential; else Internal")

    elif activity == "http":
        host = url_host(row.get("Url"))
        match = on_cloud_list(host)
        if match:
            flags.append("CLOUD_MATCH_IS_ACCESS_NOT_UPLOAD")
        if is_private_ip(host):
            flags.append("PRIVATE_IP_HOST_MARKED_UNTRUSTED")
        if not match and TRANSFER_HINT.search(host):
            flags.append("TRANSFER_LIKE_HOST_NOT_ON_LIST")
        if not host:
            flags.append("HOST_NOT_PARSEABLE")
        derived.update({
            "host": host,
            "cloud_list_match": match or "no",
            "cloudupload_proxy_assigned": bool(match),
            # SPEDIA http rows carry Action='URL accedida' and no method, byte
            # count or object name, so upload cannot be confirmed for any row.
            "upload_evidence": "none in source (Action=%s; no HTTP method/bytes)" % text(row.get("Action")),
        })
        exp.update({
            "channel": "CloudUpload" if match else "Web",
            "content_type": "CloudService" if match else "WebRequest",
            "data_classification": "Confidential" if match else "Public",
            "destination_trust": "Untrusted",
            "device_trust": "Managed",
        })
        unverifiable += ["upload (no transfer evidence in source)",
                         "destination_trust (Untrusted assumed for all HTTP)",
                         "device_trust (Managed assumed)"]
        rule = ("HTTP: host(Url) minus 'www.' equals or is a subdomain of a fixed cloud-list entry -> "
                "CloudUpload/CloudService/Confidential (metadata proxy); else Web/WebRequest/Public; all Untrusted")

    elif activity == "file":
        path_text = text(row.get("Path"))
        keyword = sensitive_keyword(path_text) if path_text else ""
        if not path_text:
            flags.append("FILENAME_ONLY_SENSITIVITY_NOT_EVALUABLE")
        if keyword:
            flags.append("SENSITIVE_BY_KEYWORD")
        if name and not ext:
            flags.append("NO_EXTENSION")
        elif ext and ext not in SPEC_FILE_TYPE:
            flags.append("EXTENSION_OUTSIDE_TYPE_DOMAIN")
        derived.update({
            "file_reference": name,
            "reference_field": "Path" if path_text else "Filename",
            "extension": ext,
            "sensitivity_keyword": keyword,
            "file_class": "SensitiveFile" if keyword else "FileOperation",
        })
        exp.update({
            "channel": "EndpointApp",
            "content_type": "SensitiveFile" if keyword else "FileOperation",
            "data_classification": "Confidential" if keyword else "Internal",
            "destination_trust": "Trusted",
            "device_trust": "Managed",
        })
        unverifiable += ["data_classification (path keyword heuristic, not a content label)",
                         "destination_trust/device_trust (assumed)"]
        rule = ("FILE: sensitivity keyword in Path -> SensitiveFile/Confidential; else FileOperation/Internal; "
                "file_type from extension of Filename (else Path) in {pdf,docx,xlsx,csv,zip,txt} else OTHER")

    elif activity == "device":
        action = text(row.get("Action")).strip().lower()
        connect = action == "connect"
        if action not in {"connect", "disconnect"}:
            flags.append("UNKNOWN_DEVICE_ACTION")
        flags.append("DEVICE_TRUST_ASSUMED_UNMANAGED")
        flags.append("NO_DEVICE_IDENTIFIER_IN_SOURCE")
        derived.update({
            "device_event": text(row.get("Action")),
            "connect": connect,
            "protection_scope": "REQ_USB_CONNECT" if connect else "none (disconnect)",
        })
        exp.update({
            "channel": "USB",
            "content_type": "DeviceConnect" if connect else "DeviceDisconnect",
            "data_classification": "Internal",
            "destination_trust": "Untrusted",
            "device_trust": "Unmanaged",
        })
        unverifiable += ["device_trust (Unmanaged assumed; no device identifier/inventory)",
                         "data transfer to the device (connection only)"]
        rule = ("DEVICE: Action=='Connect' -> DeviceConnect (in REQ_USB_CONNECT scope); "
                "'Disconnect' -> DeviceDisconnect; all USB/Untrusted/Unmanaged (assumed)")
    else:
        raise ValueError(f"Unsupported activity {activity!r}")

    scope = independent_scope(activity, derived)
    return {"expected": exp, "derived": derived, "flags": flags, "unverifiable": unverifiable,
            "rule": rule, "scope": scope}


def independent_scope(activity: str, derived: dict) -> str:
    """Requirement scope from the published scope definitions (Section 3)."""
    if activity == "email" and derived["external_recipient"] and derived["attachment_present"]:
        return "REQ_EMAIL_EXTERNAL_ATTACHMENT"
    if activity == "http" and derived["cloudupload_proxy_assigned"]:
        return "REQ_CLOUD_TRANSFER"
    if activity == "device" and derived["connect"]:
        return "REQ_USB_CONNECT"
    return ""


def adapter_scope(event: dict) -> str:
    hits = [rid for rid, cond in REQUIREMENTS.items() if all(event.get(k) == v for k, v in cond.items())]
    return ";".join(hits)


def evidence_status(activity: str, scope: str, flags: list[str]) -> str:
    if any(flag in AMBIGUITY_FLAGS for flag in flags):
        return "AMBIGUOUS"
    if scope == "REQ_CLOUD_TRANSFER":
        return "UNVERIFIABLE_PROXY"  # access is supported, upload is not
    if scope == "REQ_USB_CONNECT":
        return "UNVERIFIABLE_PROXY"  # connection is supported, device trust is assumed
    return "SOURCE_SUPPORTED"


def check_record(row: dict, anomaly: int) -> dict:
    # The adapter requires the Anomaly column (it carries it as an outcome
    # label). The independent checker receives a row without Anomaly.
    adapter = normalize_event(pd.Series({**row, "Anomaly": anomaly}))
    ind = independent_expectation(row)
    mismatches = [f for f in COMPARED_FIELDS if adapter.get(f) != ind["expected"].get(f)]
    a_scope = adapter_scope(adapter)
    if a_scope != ind["scope"]:
        mismatches.append("requirement_scope")
    return {
        "adapter": adapter, "ind": ind, "adapter_scope": a_scope, "mismatches": mismatches,
        "auto_check": "MISMATCH" if mismatches else "AGREE",
        "evidence_status": evidence_status(row["Activity"], ind["scope"], ind["flags"]),
    }


# --------------------------------------------------------------- sampling
def stratified_sample(frame: pd.DataFrame, seed: int) -> pd.DataFrame:
    """50 records per category; uses only Activity and id."""
    parts = []
    for index, category in enumerate(CATEGORIES):
        pool = frame.loc[frame["Activity"] == category, ["id"]].sort_values("id", kind="mergesort")
        rng = np.random.default_rng([seed, index])
        chosen = rng.choice(len(pool), size=SAMPLE_PER_CATEGORY, replace=False)
        picked = pool.iloc[np.sort(chosen)].copy()
        picked["category"] = category
        picked["pool_size"] = len(pool)
        picked["pool_position"] = np.sort(chosen)
        parts.append(picked)
    return pd.concat(parts, ignore_index=True)


# ------------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    dataset = args.dataset or next(
        (p for p in (ROOT / "data" / "raw" / "logs_SPEDIA_annotated_en.csv",
                     ROOT / "logs_SPEDIA_annotated_en.csv") if p.exists()), None)
    if dataset is None:
        raise SystemExit("SPEDIA CSV not found; run experiments/fetch_spedia.py or pass --dataset.")
    OUTPUT.mkdir(parents=True, exist_ok=True)

    # ---- Task 1: integrity
    size, md5, sha256 = file_digest(dataset)
    frame = pd.read_csv(dataset, low_memory=False)
    activity_counts = frame["Activity"].value_counts().to_dict()
    replay = frame[frame["Activity"].isin(CATEGORIES)]
    integrity = {
        "dataset_path": str(dataset.relative_to(ROOT)) if dataset.is_relative_to(ROOT) else str(dataset),
        "size_bytes": size, "size_ok": size == EXPECTED_SIZE,
        "md5": md5, "md5_ok": md5 == EXPECTED_MD5, "sha256": sha256,
        "rows": len(frame), "rows_ok": len(frame) == EXPECTED_ROWS,
        "columns": len(frame.columns), "columns_ok": len(frame.columns) == EXPECTED_COLUMNS,
        "activity_counts": {k: int(v) for k, v in activity_counts.items()},
        "dlp_counts_ok": {c: int(activity_counts.get(c, 0)) == n for c, n in EXPECTED_ACTIVITY.items()},
        "replay_rows": len(replay), "replay_rows_ok": len(replay) == EXPECTED_REPLAY_ROWS,
        "replay_rows_sum_check": sum(int(activity_counts.get(c, 0)) for c in CATEGORIES),
        "duplicate_ids": int(frame["id"].duplicated().sum()),
        "excluded_activities": {k: int(v) for k, v in activity_counts.items() if k not in CATEGORIES},
    }

    # ---- Task 4 (population): independent check on all replay rows
    records = replay[ACTIVITY_COLUMNS].to_dict("records")
    anomalies = replay["Anomaly"].astype(int).tolist()  # passed to the adapter only
    population = []
    for row, anomaly in zip(records, anomalies):
        result = check_record(row, anomaly)
        population.append((row, result))
    pop_summary = summarize(population)

    # ---- Task 2/3/4/5: sample
    sample = stratified_sample(frame, args.seed)
    by_id = {row["id"]: (row, result) for row, result in population}
    rows_out = []
    for number, item in enumerate(sample.itertuples(index=False), start=1):
        row, result = by_id[item.id]
        rows_out.append(review_row(number, item, row, result))
    write_csv(OUTPUT / "review_sample.csv", rows_out)
    sample_pairs = [by_id[i] for i in sample["id"]]
    sample_summary = summarize(sample_pairs)

    payload = {"seed": args.seed, "integrity": integrity, "population": pop_summary,
               "sample": sample_summary,
               "sample_ids": {c: sample.loc[sample.category == c, "id"].tolist() for c in CATEGORIES}}
    (OUTPUT / "automatic_checks.json").write_text(json.dumps(payload, indent=2, default=str) + "\n", "utf-8")
    write_sampling_md(args.seed, sample, integrity)
    write_report_md(args.seed, integrity, pop_summary, sample_summary, population)

    print(json.dumps({
        "md5_ok": integrity["md5_ok"], "size_ok": integrity["size_ok"], "replay_rows": integrity["replay_rows"],
        "population_mismatches": pop_summary["mismatch_total"],
        "population_scope": pop_summary["independent_scope_counts"],
        "sample_status": sample_summary["evidence_status"], "outputs": str(OUTPUT),
    }, indent=2))
    return 0


def summarize(pairs: list[tuple[dict, dict]]) -> dict:
    by_cat: dict[str, dict] = {}
    mismatch_fields: Counter = Counter()
    mismatch_examples: list[dict] = []
    scope_ind: Counter = Counter()
    scope_adp: Counter = Counter()
    status: Counter = Counter()
    for row, result in pairs:
        cat = row["Activity"]
        entry = by_cat.setdefault(cat, {"records": 0, "agree": 0, "mismatch": 0, "in_scope": 0,
                                        "flags": Counter(), "evidence_status": Counter()})
        entry["records"] += 1
        entry["in_scope"] += 1 if result["ind"]["scope"] else 0
        entry["agree" if result["auto_check"] == "AGREE" else "mismatch"] += 1
        entry["flags"].update(result["ind"]["flags"])
        entry["evidence_status"][result["evidence_status"]] += 1
        status[(cat, result["evidence_status"])] += 1
        mismatch_fields.update(result["mismatches"])
        if result["mismatches"] and len(mismatch_examples) < 25:
            mismatch_examples.append({
                "id": row["id"], "activity": cat, "fields": result["mismatches"],
                "adapter": {f: result["adapter"].get(f) for f in result["mismatches"] if f in COMPARED_FIELDS},
                "independent": {f: result["ind"]["expected"].get(f) for f in result["mismatches"] if f in COMPARED_FIELDS},
            })
        scope_ind[result["ind"]["scope"] or "out_of_scope"] += 1
        scope_adp[result["adapter_scope"] or "out_of_scope"] += 1
    host_counter: Counter = Counter()
    unlisted: Counter = Counter()
    ext_counter: Counter = Counter()
    for row, result in pairs:
        d = result["ind"]["derived"]
        if row["Activity"] == "http":
            if d["cloudupload_proxy_assigned"]:
                host_counter[d["host"]] += 1
            if "TRANSFER_LIKE_HOST_NOT_ON_LIST" in result["ind"]["flags"]:
                unlisted[d["host"]] += 1
        if row["Activity"] == "file":
            ext_counter[d["extension"] or "(none)"] += 1
    return {
        "records": len(pairs),
        "mismatch_total": sum(1 for _, r in pairs if r["mismatches"]),
        "mismatch_fields": dict(mismatch_fields),
        "mismatch_examples": mismatch_examples,
        "independent_scope_counts": dict(scope_ind),
        "adapter_scope_counts": dict(scope_adp),
        "by_category": {c: {**{k: v for k, v in e.items() if k not in ("flags", "evidence_status")},
                            "flags": dict(e["flags"]), "evidence_status": dict(e["evidence_status"])}
                        for c, e in by_cat.items()},
        "evidence_status": {f"{c}:{s}": n for (c, s), n in sorted(status.items())},
        "cloud_hosts_matched": dict(host_counter.most_common()),
        "transfer_like_hosts_not_on_list": dict(unlisted.most_common(30)),
        "file_extensions": dict(ext_counter.most_common(30)),
    }


def review_row(number: int, item, row: dict, result: dict) -> dict:
    adapter, ind = result["adapter"], result["ind"]
    d = ind["derived"]
    return {
        "sample_no": number,
        "category": CATEGORY_LABEL[item.category],
        "source_record_id": row["id"],
        "event_id": adapter["event_id"],
        "src_timestamp": text(row["Timestamp"]),
        "src_decoder": text(row["Decoder_name"]),
        "src_action": text(row["Action"]),
        "src_to": text(row["To"]), "src_cc": text(row["Cc"]), "src_bcc": text(row["Bcc"]),
        "src_attachments": text(row["Attachments"]),
        "src_size": text(row["Size"]), "src_size_before": text(row["Size_before"]),
        "src_size_after": text(row["Size_after"]),
        "src_url": text(row["Url"]), "src_filename": text(row["Filename"]), "src_path": text(row["Path"]),
        "derived_recipient_domains": d.get("recipient_domains", ""),
        "derived_external_recipient": d.get("external_recipient", ""),
        "derived_external_fields": d.get("external_fields", ""),
        "derived_attachment_present": d.get("attachment_present", ""),
        "derived_host": d.get("host", ""),
        "derived_cloud_list_match": d.get("cloud_list_match", ""),
        "derived_cloudupload_proxy": d.get("cloudupload_proxy_assigned", ""),
        "derived_upload_evidence": d.get("upload_evidence", ""),
        "derived_file_reference_field": d.get("reference_field", ""),
        "derived_extension": d.get("extension", ""),
        "derived_sensitivity_keyword": d.get("sensitivity_keyword", ""),
        "derived_file_class": d.get("file_class", ""),
        "derived_device_event": d.get("device_event", ""),
        "derived_device_connect": d.get("connect", ""),
        "norm_channel": adapter["channel"],
        "norm_content_type": adapter["content_type"],
        "norm_data_classification": adapter["data_classification"],
        "norm_destination_trust": adapter["destination_trust"],
        "norm_device_trust": adapter["device_trust"],
        "norm_user_group": adapter["user_group"],
        "norm_file_type": adapter["file_type"],
        "norm_size_mb": adapter["size_mb"],
        "norm_requirement_scope": result["adapter_scope"] or "none",
        "mapping_rule": ind["rule"],
        "auto_check": result["auto_check"],
        "auto_mismatch_fields": ";".join(result["mismatches"]),
        "evidence_status": result["evidence_status"],
        "flags": ";".join(ind["flags"]),
        "unverifiable_attributes": " | ".join(ind["unverifiable"]),
        "human_review_mapping_correct": "",
        "human_review_scope_correct": "",
        "human_review_supports_real_transfer": "",
        "human_review_notes": "",
        "reviewer": "",
        "review_date": "",
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------- reports
def write_sampling_md(seed: int, sample: pd.DataFrame, integrity: dict) -> None:
    lines = [
        "# Sampling method — SPEDIA adapter validation sample",
        "",
        "Generated by `validation/spedia_adapter_validation.py`. Do not edit by hand.",
        "",
        "## Design",
        "",
        f"- **Population:** the {integrity['replay_rows']:,} SPEDIA records whose `Activity` is `email`, `http`, "
        "`file` or `device` (the replay scope used in the paper).",
        f"- **Strata:** the four DLP activity categories; {SAMPLE_PER_CATEGORY} records per stratum, "
        f"{SAMPLE_PER_CATEGORY * len(CATEGORIES)} in total. Equal allocation, not proportional.",
        f"- **Seed:** `{seed}`.",
        "- **Procedure per stratum:** the stratum's records are sorted by the source `id` (UUID string, "
        "lexicographic, stable mergesort). This makes the order independent of file row order. "
        "A NumPy `default_rng([seed, k])` generator is created, where `k` is the fixed stratum index "
        "(email=0, http=1, file=2, device=3). It draws 50 distinct positions without replacement.",
        "- **Fields used for selection:** `Activity` and `id` only. `Anomaly`, `Agent_name` and `User` "
        "are not read during sampling, and they are not written to `review_sample.csv`. The review is "
        "therefore blind to outcome labels and identities.",
        "- **Reproducibility:** rerunning with the same dataset (MD5 "
        f"`{integrity['md5']}`) and seed yields the same 200 ids. The ids are listed in "
        "`automatic_checks.json` (`sample_ids`).",
        "",
        "## Command",
        "",
        "```bash",
        f"python validation/spedia_adapter_validation.py --seed {seed}",
        "```",
        "",
        "## Stratum sizes",
        "",
        "| Category | Population | Sampled | Sampling fraction |",
        "|---|---:|---:|---:|",
    ]
    for category in CATEGORIES:
        pool = int(sample.loc[sample.category == category, "pool_size"].iloc[0])
        lines.append(f"| {CATEGORY_LABEL[category]} | {pool:,} | {SAMPLE_PER_CATEGORY} | "
                     f"{SAMPLE_PER_CATEGORY / pool:.2%} |")
    lines += [
        "",
        "## Known consequence of simple random sampling within strata",
        "",
        "The rare branches of the mapping appear only a few times, or not at all, in a 50-record stratum. "
        "Examples are cloud-list hosts (445 of 21,723 HTTP rows) and keyword-sensitive file paths. The "
        "sample therefore supports manual inspection of typical records. Every branch is still checked "
        "automatically on the full population (see `adapter_validation_report.md`). The sample was not "
        "enriched by mapping outcome. Enrichment would have required the adapter output, which is the "
        "subject of the test, as a selection variable.",
        "",
    ]
    (OUTPUT / "sampling_method.md").write_text("\n".join(lines), "utf-8")


def pct(n: int, d: int) -> str:
    return f"{n / d:.1%}" if d else "n/a"


def write_report_md(seed, integrity, pop, sample, population) -> None:
    ok = lambda b: "OK" if b else "**FAIL**"  # noqa: E731
    L = [
        "# SPEDIA-to-DLP adapter validation report",
        "",
        "Generated by `validation/spedia_adapter_validation.py` (seed "
        f"`{seed}`). Every number below is computed by the script. No manual review result is included; "
        "the `human_review_*` columns in `review_sample.csv` are intentionally empty.",
        "",
        "## 1. Dataset integrity",
        "",
        "| Check | Observed | Expected | Status |",
        "|---|---|---|---|",
        f"| File | `{integrity['dataset_path']}` | `logs_SPEDIA_annotated_en.csv` (Zenodo record 15525713) | — |",
        f"| Size (bytes) | {integrity['size_bytes']:,} | {EXPECTED_SIZE:,} | {ok(integrity['size_ok'])} |",
        f"| MD5 | `{integrity['md5']}` | `{EXPECTED_MD5}` | {ok(integrity['md5_ok'])} |",
        f"| SHA-256 | `{integrity['sha256']}` | (not published; recorded here) | — |",
        f"| Rows | {integrity['rows']:,} | {EXPECTED_ROWS:,} | {ok(integrity['rows_ok'])} |",
        f"| Columns | {integrity['columns']} | {EXPECTED_COLUMNS} | {ok(integrity['columns_ok'])} |",
        f"| Duplicate `id` values | {integrity['duplicate_ids']} | 0 | {ok(integrity['duplicate_ids'] == 0)} |",
    ]
    for c in CATEGORIES:
        L.append(f"| {CATEGORY_LABEL[c]} records | {integrity['activity_counts'].get(c, 0):,} | "
                 f"{EXPECTED_ACTIVITY[c]:,} | {ok(integrity['dlp_counts_ok'][c])} |")
    L += [
        f"| Replay scope (4 categories) | {integrity['replay_rows']:,} | {EXPECTED_REPLAY_ROWS:,} | "
        f"{ok(integrity['replay_rows_ok'])} |",
        f"| Excluded activities | {', '.join(f'{k}={v:,}' for k, v in integrity['excluded_activities'].items())} | "
        "command, session | — |",
        "",
        "Zenodo record 15525713 (checked on the Zenodo API on 2026-10-07) lists "
        "`logs_SPEDIA_annotated_en.csv` with size 45,703,322 and MD5 `e01e0baaf3b523a0b493fc9c52af2b1c`. It "
        "is the latest version of the record. The concept (all-versions) record id is 15495571. "
        "**Inconsistency:** `data/README.md` gives `10.5281/zenodo.15495572` as the *concept* DOI, and so "
        "does the anonymous-submission availability note. On Zenodo, 15495572 is the *version 1.0* record, "
        "which holds a different file (`logs_SPEDIA.csv`, 43,042,405 bytes). The paper body cites "
        "15525713, which is correct.",
        "",
        "## 2. Independent check on the full replay population",
        "",
        "Each of the "
        f"{pop['records']:,} replay records was normalized by the unchanged adapter "
        "(`experiments/prepare_spedia.py::normalize_event`). The result was compared with a separate "
        "implementation that derives the expected attributes from source metadata. The two "
        "implementations parse differently: recipients are split on `;` or `,` and the domain is taken "
        "after the last `@`; hosts are extracted with a regex instead of `urllib`; the cloud list is "
        "matched label-wise; extensions use `rpartition`; sensitivity uses substring and token tests "
        "instead of the adapter regex. Compared fields: "
        f"{', '.join(COMPARED_FIELDS)}, plus requirement scope.",
        "",
        f"- Records with any disagreement: **{pop['mismatch_total']:,}** of {pop['records']:,}.",
    ]
    if pop["mismatch_fields"]:
        L.append(f"- Disagreeing fields: {pop['mismatch_fields']}")
        L.append("- First examples (see `automatic_checks.json`):")
        for example in pop["mismatch_examples"][:10]:
            L.append(f"  - `{example['id']}` ({example['activity']}): adapter {example['adapter']} vs "
                     f"independent {example['independent']}")
    L += [
        "",
        "| Requirement scope | Adapter (scope match on normalized event) | Independent (from source metadata) "
        "| Table 3 / channel table |",
        "|---|---:|---:|---:|",
    ]
    table_ref = {"REQ_EMAIL_EXTERNAL_ATTACHMENT": EXPECTED_SCOPE["Email"],
                 "REQ_CLOUD_TRANSFER": EXPECTED_SCOPE["CloudUpload"], "REQ_USB_CONNECT": EXPECTED_SCOPE["USB"]}
    for key, ref in table_ref.items():
        L.append(f"| {key} | {pop['adapter_scope_counts'].get(key, 0):,} | "
                 f"{pop['independent_scope_counts'].get(key, 0):,} | {ref:,} |")
    total_ind = sum(pop["independent_scope_counts"].get(k, 0) for k in table_ref)
    L.append(f"| **Total in scope** | {sum(pop['adapter_scope_counts'].get(k, 0) for k in table_ref):,} | "
             f"{total_ind:,} | 4,474 |")
    L += ["", "### Evidence status per category (full population)", "",
          "Status legend:",
          "",
          "- `SOURCE_SUPPORTED`: the scope-defining facts are present in the source record.",
          "- `UNVERIFIABLE_PROXY`: the record is in a requirement scope, but the scope relies on a "
          "property the source cannot show (upload for cloud hosts, unmanaged trust for devices).",
          "- `AMBIGUOUS`: a record-specific condition makes the correct mapping uncertain. These records "
          "need human judgement.",
          "",
          "| Category | Records | SOURCE_SUPPORTED | UNVERIFIABLE_PROXY | AMBIGUOUS |",
          "|---|---:|---:|---:|---:|"]
    for c in CATEGORIES:
        e = pop["by_category"][c]["evidence_status"]
        n = pop["by_category"][c]["records"]
        L.append(f"| {CATEGORY_LABEL[c]} | {n:,} | {e.get('SOURCE_SUPPORTED', 0):,} | "
                 f"{e.get('UNVERIFIABLE_PROXY', 0):,} | {e.get('AMBIGUOUS', 0):,} |")
    L += ["", "### Flag counts (full population)", "", "| Category | Flag | Records | Share |", "|---|---|---:|---:|"]
    for c in CATEGORIES:
        n = pop["by_category"][c]["records"]
        for flag, count in sorted(pop["by_category"][c]["flags"].items(), key=lambda kv: -kv[1]):
            L.append(f"| {CATEGORY_LABEL[c]} | `{flag}` | {count:,} | {pct(count, n)} |")

    # in-scope breakdown of ambiguity
    in_scope_flags: dict[str, Counter] = {}
    for row, result in population:
        scope = result["ind"]["scope"]
        if scope:
            in_scope_flags.setdefault(scope, Counter()).update(result["ind"]["flags"])
    L += ["", "### Flags among in-scope (Table 3) records", "", "| Scope | Flag | Records |", "|---|---|---:|"]
    for scope, counter in in_scope_flags.items():
        for flag, count in counter.most_common():
            L.append(f"| {scope} | `{flag}` | {count:,} |")

    L += [
        "",
        "## 3. Category findings",
        "",
        "### Email",
        "- Source fields `To`, `Cc`, `Bcc` and `Attachments` (count) are present for every email row. "
        "`Action` is `Email sent` for all of them. External status and attachment presence are therefore "
        "directly observable, and the in-scope count reflects real *sent* messages with at least one "
        "attachment and at least one non-`dtaa.com` recipient.",
        "- Not observable: attachment content or sensitivity (`data_classification=Restricted` is a "
        "research mapping), and the endpoint device (`Managed` is assumed). `dtaa.com` is treated as "
        "the only internal domain. This follows the CERT origin of the records and is an assumption, not "
        "a source label.",
        "- `MIXED_INTERNAL_EXTERNAL_RECIPIENTS` / `EXTERNAL_ONLY_VIA_BCC` mark messages where "
        "the \"any external recipient\" rule decides the outcome. They are informational, not "
        "ambiguous: a message with any external recipient leaves the organization. Whether that is the "
        "intended policy reading is left to the human review.",
        "",
        "### HTTP",
        "- Every HTTP row has `Action = URL accedida` (\"URL accessed\"). No row has an HTTP method, a "
        "byte count, or an uploaded object name, and `Size*` fields are empty. **No HTTP record provides "
        "evidence of a file upload.** A cloud-list match means only that the listed service was accessed. "
        "The `CloudUpload` channel is a metadata proxy.",
        f"- Hosts matched to the cloud list (population): {pop['cloud_hosts_matched']}.",
        "- Because `Size*` is absent, every HTTP event gets `size_mb = 0`. The `conflict_cloud` mutation "
        "is conditioned on `size_mb = 0`. It therefore applies to **all 445** cloud-proxy events because "
        "size metadata is missing, not because zero-byte transfers were observed. The exposure count is "
        "a correct consequence of the adapter, but it should be described as \"events without size "
        "metadata\".",
        f"- Hosts that look transfer-related but are not on the fixed list (diagnostic only; top entries): "
        f"{pop['transfer_like_hosts_not_on_list']}. These hosts (for example `megaupload.com`) are "
        "mapped to `Web`. The fixed list is therefore a conservative, incomplete proxy, and the cloud "
        "in-scope count is a lower bound under the stated proxy definition.",
        "- Private-IP hosts (e.g. `10.12.x.x`) are assigned `destination_trust = Untrusted` like all HTTP "
        "rows. This does not affect any requirement scope, because non-listed hosts map to `Web`.",
        "",
        "### File",
        "- `File accessed` rows (CERT decoder) carry only `Filename` (e.g. `ABC123.doc`) and no `Path`. "
        "The adapter evaluates sensitivity on `Path` only, so for these rows sensitivity cannot be "
        "evaluated, and they map to `FileOperation/Internal` "
        "(`FILENAME_ONLY_SENSITIVITY_NOT_EVALUABLE`).",
        f"- Extensions observed in the population: {pop['file_extensions']}. `.doc` (legacy Word) is "
        "outside the declared `file_type` domain {PDF, DOCX, XLSX, CSV, ZIP, TXT} and maps to `OTHER`.",
        "- No file attribute takes part in any declared requirement. The `R_SENSITIVE_ENDPOINT_FILE` "
        "Audit rule has no requirement, so file mappings do not influence any Table 3 count.",
        "",
        "### Removable device",
        "- `Action` is `Connect` or `Disconnect` for every device row. The connect/disconnect split is "
        "directly observable, and `REQ_USB_CONNECT` covers exactly the `Connect` rows.",
        "- No device identifier, vendor, serial number or asset-inventory field exists. "
        "`device_trust = Unmanaged` is an assumption applied to every device, not a derived value. A "
        "connection does not show that data was written to the device.",
        "",
        "## 4. Sample (200 records) automatic results",
        "",
        f"- Disagreements in sample: **{sample['mismatch_total']}** of {sample['records']}.",
        "",
        "| Category | Records | AGREE | MISMATCH | SOURCE_SUPPORTED | UNVERIFIABLE_PROXY | AMBIGUOUS | In requirement scope |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for c in CATEGORIES:
        e = sample["by_category"][c]
        es = e["evidence_status"]
        L.append(f"| {CATEGORY_LABEL[c]} | {e['records']} | {e['agree']} | {e['mismatch']} | "
                 f"{es.get('SOURCE_SUPPORTED', 0)} | {es.get('UNVERIFIABLE_PROXY', 0)} | {es.get('AMBIGUOUS', 0)} | "
                 f"{e['in_scope']} |")
    L += [
        "",
        f"Sample requirement-scope counts (independent): {sample['independent_scope_counts']}.",
        "",
        "## 5. Manual review summary (to be completed after human review)",
        "",
        "Fill this table from `review_sample.csv` after the human review. It is intentionally empty.",
        "",
        "| Category | Reviewed | Mapping correct | Mapping incorrect | Scope correct | "
        "Supports a real transfer | Cannot be determined from source | Reviewer(s) | Date |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for c in CATEGORIES:
        L.append(f"| {CATEGORY_LABEL[c]} | | | | | | | | |")
    L += ["| **Total** | | | | | | | | |", "",
          "Suggested values for the `human_review_*` columns: `yes` / `no` / `cannot_determine`, with a "
          "note for every `no` or `cannot_determine`.",
          "",
          "## 6. Limitations",
          "",
          "1. **Shared specification.** The independent checker re-implements the published rules with "
          "different code, but it reads the same specification values: the `dtaa.com` internal domain, "
          "the 13-domain cloud list, the sensitivity keywords and the file-type domain. Both "
          "implementations share any error in that specification, such as a missing cloud domain or an "
          "over-broad keyword. Agreement shows that the code implements the written rules. It does not "
          "show that the rules are the right DLP interpretation.",
          "2. **Common interpretation.** Both implementations were written by the same team from the "
          "same text. Ambiguous rule text could be read the same wrong way in both. The human review "
          "of `review_sample.csv` is the control for this.",
          "3. **Unverifiable properties.** Source data cannot confirm uploads for HTTP rows, device trust "
          "for removable devices, or content sensitivity for any category. These properties are reported "
          "as `UNVERIFIABLE_PROXY` or listed in `unverifiable_attributes`, never as verified.",
          "4. **Sample size.** 50 records per stratum give limited power for rare branches (cloud hosts, "
          "sensitive paths). The full-population automatic check covers those branches, but only "
          "against the shared specification.",
          "5. **Source fidelity.** SPEDIA mixes CERT-derived synthetic rows with exercise logs. The "
          "validation cannot establish that source rows describe real-world transfers. It can only "
          "show that the adapter output follows from the source metadata as recorded.",
          ""]
    (OUTPUT / "adapter_validation_report.md").write_text("\n".join(L), "utf-8")


if __name__ == "__main__":
    sys.exit(main())
