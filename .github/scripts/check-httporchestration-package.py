#!/usr/bin/env python3
"""Validate release identity, licensing, and source URLs without printing contents."""

import argparse
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

REPOSITORY = "https://github.com/ProBonoLaw/pbl-file-operations"


def validate(package, version, commit):
    with zipfile.ZipFile(package) as archive:
        names = archive.namelist()
        nuspecs = [name for name in names if name.endswith(".nuspec")]
        if len(nuspecs) != 1:
            raise ValueError("Package must contain exactly one nuspec")
        root = ET.fromstring(archive.read(nuspecs[0]))
        metadata = {element.tag.split("}")[-1]: element for element in root.iter()}
        def value(name):
            return metadata[name].text if name in metadata else None
        if value("id") != "DaatPhoenix.HttpOrchestration" or value("version") != version:
            raise ValueError("Unexpected package identity or version")
        if value("license") != "Apache-2.0" or metadata["license"].get("type") != "expression":
            raise ValueError("Package must declare its Apache-2.0 license")
        repository = metadata.get("repository")
        if repository is None or repository.get("url") != REPOSITORY or repository.get("commit") != commit:
            raise ValueError("Package must reference the public source repository and build commit")
        if value("projectUrl") != REPOSITORY + "/tree/main/src/HttpOrchestration":
            raise ValueError("Package project URL must reference the public source")
        for required in ("README.md", "LICENSE", "NOTICE", "lib/net10.0/HttpOrchestration.dll"):
            if required not in names or not archive.read(required):
                raise ValueError(f"Missing or empty package file: {required}")
        for name in names:
            payload = archive.read(name)
            # Scan ordinary text and assembly metadata, including UTF-16 strings.
            for text in (payload.decode("utf-8", errors="ignore"),
                         payload.decode("utf-16-le", errors="ignore")):
                for url in re.findall(r"https?://github\.com/[\w.-]+/[\w.-]+", text, re.I):
                    if url.rstrip(".").removesuffix(".git").lower() != REPOSITORY.lower():
                        raise ValueError(f"Unexpected source repository URL in {name}")
                if re.search(r"/Users/[^/]+/|[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}", text, re.I):
                    raise ValueError(f"Review personal path or email in {name}")
    print(f"Validated {Path(package).name}: public source metadata and licensing")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    validate(args.package, args.version, args.commit)
