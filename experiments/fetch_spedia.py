#!/usr/bin/env python3
"""Download and checksum the annotated SPEDIA CSV used by the paper."""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path


URL = "https://zenodo.org/records/15525713/files/logs_SPEDIA_annotated_en.csv?download=1"
EXPECTED_MD5 = "e01e0baaf3b523a0b493fc9c52af2b1c"
EXPECTED_SIZE = 45_703_322
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data" / "raw" / "logs_SPEDIA_annotated_en.csv"


def md5sum(path: Path) -> str:
    digest = hashlib.md5()  # nosec B324 - used only for dataset identity
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path) -> None:
    actual_size = path.stat().st_size
    actual_md5 = md5sum(path)
    if actual_size != EXPECTED_SIZE or actual_md5 != EXPECTED_MD5:
        raise RuntimeError(
            f"SPEDIA verification failed: size={actual_size}, md5={actual_md5}; "
            f"expected size={EXPECTED_SIZE}, md5={EXPECTED_MD5}."
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.force:
        verify(output)
        print(f"Verified existing SPEDIA dataset: {output}")
        return 0

    partial = output.with_suffix(output.suffix + ".part")
    request = urllib.request.Request(URL, headers={"User-Agent": "PolicyLint-DLP/0.2"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        verify(partial)
        partial.replace(output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise

    print(f"Downloaded and verified SPEDIA dataset: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

