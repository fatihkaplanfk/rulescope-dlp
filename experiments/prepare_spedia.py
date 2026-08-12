#!/usr/bin/env python3
"""Normalize SPEDIA records into vendor-neutral PolicyLint-DLP events.

The transformation deliberately excludes Agent_name and User. Anomaly is kept
only as an outcome label and must never be consumed by policy conditions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd


EXPECTED_COLUMNS = {
    "id", "Agent_name", "User", "Timestamp", "Content", "Url", "To", "Cc",
    "Bcc", "From", "Attachments", "Size", "Size_before", "Size_after",
    "Filename", "Path", "Activity", "Action", "Anomaly",
}
DLP_ACTIVITIES = {"email", "http", "file", "device"}
INTERNAL_EMAIL_DOMAIN = "dtaa.com"
CLOUD_TRANSFER_DOMAINS = {
    "4shared.com", "box.com", "docs.google.com", "drive.google.com",
    "dropbox.com", "github.com", "gitlab.com", "mediafire.com", "mega.nz",
    "onedrive.live.com", "pastebin.com", "sourceforge.net", "wetransfer.com",
}
SENSITIVE_PATH = re.compile(
    r"(?:/etc/(?:shadow|passwd|sudoers)|/\.ssh/|id_rsa|\.pem(?:$|\b)|"
    r"private[_-]?key|credential|secret|token|password|passwd|database|"
    r"\.db(?:$|\b)|\.sqlite(?:$|\b)|dump|backup)",
    re.IGNORECASE,
)
FILE_TYPES = {
    ".pdf": "PDF", ".docx": "DOCX", ".xlsx": "XLSX", ".csv": "CSV",
    ".zip": "ZIP", ".txt": "TXT",
}


def is_missing(value: object) -> bool:
    return value is None or bool(pd.isna(value))


def recipient_is_external(value: object) -> bool:
    if is_missing(value):
        return False
    recipients = [item.strip().lower() for item in str(value).split(";")]
    return any("@" in item and not item.endswith(f"@{INTERNAL_EMAIL_DOMAIN}") for item in recipients)


def hostname(value: object) -> str:
    if is_missing(value):
        return ""
    try:
        return (urlparse(str(value)).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def is_cloud_transfer_domain(host: str) -> bool:
    return any(host == domain or host.endswith(f".{domain}") for domain in CLOUD_TRANSFER_DOMAINS)


def normalized_size_mb(row: pd.Series) -> int:
    for column in ("Size", "Size_after", "Size_before"):
        value = row.get(column)
        if not is_missing(value) and float(value) > 0:
            return min(10240, max(1, math.ceil(float(value) / (1024 * 1024))))
    return 0


def normalized_file_type(row: pd.Series) -> str:
    candidate = row.get("Filename")
    if is_missing(candidate):
        candidate = row.get("Path")
    if is_missing(candidate):
        return "OTHER"
    return FILE_TYPES.get(Path(str(candidate)).suffix.lower(), "OTHER")


def base_event(row: pd.Series) -> dict[str, object]:
    return {
        "event_id": hashlib.sha256(str(row["id"]).encode("utf-8")).hexdigest()[:16],
        "timestamp": str(row["Timestamp"]),
        "source_activity": str(row["Activity"]),
        "source_action": str(row["Action"]),
        "anomaly": int(row["Anomaly"]),
        "user_group": "General",
        "size_mb": normalized_size_mb(row),
        "file_type": normalized_file_type(row),
    }


def normalize_event(row: pd.Series) -> dict[str, object]:
    event = base_event(row)
    activity = row["Activity"]

    if activity == "email":
        external = any(recipient_is_external(row.get(column)) for column in ("To", "Cc", "Bcc"))
        has_attachment = not is_missing(row.get("Attachments")) and float(row["Attachments"]) > 0
        event.update({
            "data_classification": "Restricted" if external and has_attachment else (
                "Confidential" if external or has_attachment else "Internal"
            ),
            "content_type": "Attachment" if has_attachment else "Message",
            "channel": "Email",
            "destination_trust": "Untrusted" if external else "Trusted",
            "device_trust": "Managed",
        })
        return event

    if activity == "http":
        host = hostname(row.get("Url"))
        cloud = is_cloud_transfer_domain(host)
        event.update({
            "data_classification": "Confidential" if cloud else "Public",
            "content_type": "CloudService" if cloud else "WebRequest",
            "channel": "CloudUpload" if cloud else "Web",
            "destination_trust": "Untrusted",
            "device_trust": "Managed",
        })
        return event

    if activity == "file":
        path = "" if is_missing(row.get("Path")) else str(row["Path"])
        sensitive = bool(SENSITIVE_PATH.search(path))
        event.update({
            "data_classification": "Confidential" if sensitive else "Internal",
            "content_type": "SensitiveFile" if sensitive else "FileOperation",
            "channel": "EndpointApp",
            "destination_trust": "Trusted",
            "device_trust": "Managed",
        })
        return event

    if activity == "device":
        connected = str(row["Action"]).strip().lower() == "connect"
        event.update({
            "data_classification": "Internal",
            "content_type": "DeviceConnect" if connected else "DeviceDisconnect",
            "channel": "USB",
            "destination_trust": "Untrusted",
            "device_trust": "Unmanaged",
        })
        return event

    raise ValueError(f"Unsupported activity: {activity}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    args = parser.parse_args()

    frame = pd.read_csv(args.input, low_memory=False)
    missing = EXPECTED_COLUMNS.difference(frame.columns)
    if missing:
        raise RuntimeError(f"SPEDIA file is missing columns: {sorted(missing)}")
    if not set(frame["Anomaly"].dropna().unique()).issubset({0, 1}):
        raise RuntimeError("SPEDIA Anomaly must be binary.")

    dlp = frame[frame["Activity"].isin(DLP_ACTIVITIES)].copy()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as target:
        for _, row in dlp.iterrows():
            target.write(json.dumps(normalize_event(row), ensure_ascii=False, separators=(",", ":")))
            target.write("\n")

    profile = (
        frame.groupby(["Activity", "Anomaly"], dropna=False)
        .size().unstack(fill_value=0).rename(columns={0: "non_anomaly", 1: "anomaly"})
        .reset_index()
    )
    profile["total"] = profile["non_anomaly"] + profile["anomaly"]
    profile["included_in_replay"] = profile["Activity"].isin(DLP_ACTIVITIES)
    args.profile.parent.mkdir(parents=True, exist_ok=True)
    profile.to_csv(args.profile, index=False)

    print(json.dumps({
        "source_rows": int(len(frame)),
        "normalized_rows": int(len(dlp)),
        "anomaly_rows": int(dlp["Anomaly"].sum()),
        "non_anomaly_rows": int(len(dlp) - dlp["Anomaly"].sum()),
        "time_start": str(frame["Timestamp"].min()),
        "time_end": str(frame["Timestamp"].max()),
        "distinct_days": int(frame["Timestamp"].astype(str).str[:10].nunique()),
        "decision_features_excluded": ["Anomaly", "Agent_name", "User"],
    }))


if __name__ == "__main__":
    main()

