#!/usr/bin/env python3
"""Prepare a bounded source distribution without consulting Git or publishing it."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile


ROOT = Path(__file__).resolve().parent.parent
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_FILES = 4096
TOP_FILES = (
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
    "vitest.config.ts",
    ".prettierrc.json",
    ".prettierignore",
    ".gitignore",
    ".env.example",
    "AGENTS.md",
    "README.md",
    "LICENSE",
    "NOTICE",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
)
TOP_DIRECTORIES = ("src", "tests", "examples", "docs", "scripts", ".github")
EXCLUDED_NAMES = frozenset(
    (
        ".git",
        ".claude",
        ".DS_Store",
        "node_modules",
        "dist",
        "artifacts",
        "coverage",
        "__pycache__",
        "be",
        "ui",
        "shared",
        "worker",
        "gateway",
        "IAC",
        "sdk",
        "sdk-python",
        "mcp",
        "audit-verifier",
        "website",
        "infra",
    )
)


class ArchiveError(Exception):
    """A bounded, non-secret diagnostic suitable for the command line."""


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def excluded(name):
    return (
        name in EXCLUDED_NAMES
        or name.startswith(".env")
        or name.startswith(".qa")
        or name.endswith((".pyc", ".pyo", ".tgz", ".tar.gz", ".zip"))
    )


def collect_sources():
    """Open every component relative to owned directory descriptors, refusing links."""
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ArchiveError("Source preparation requires no-follow directory reads on this host.")
    snapshots = {}
    total = 0

    def capture(directory_fd, name, parts):
        nonlocal total
        path = "/".join(parts)
        if len(path.encode("utf-8")) > 4096:
            raise ArchiveError("A selected source path exceeds the archive path limit.")
        flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(name, flags, dir_fd=directory_fd)
        try:
            information = os.fstat(descriptor)
            if not stat.S_ISREG(information.st_mode):
                raise ArchiveError("A selected source entry is not a regular file.")
            if information.st_size > MAX_FILE_BYTES:
                raise ArchiveError("A selected source file exceeds the 2 MiB limit.")
            chunks = []
            size = 0
            while True:
                block = os.read(descriptor, min(65536, MAX_FILE_BYTES + 1 - size))
                if not block:
                    break
                size += len(block)
                if size > MAX_FILE_BYTES:
                    raise ArchiveError("A selected source file exceeds the 2 MiB limit.")
                chunks.append(block)
            total += size
            if total > MAX_TOTAL_BYTES or len(snapshots) >= MAX_FILES:
                raise ArchiveError("Selected source exceeds the total archive size or file limit.")
            snapshots[path] = b"".join(chunks)
        finally:
            os.close(descriptor)

    def visit(directory_fd, parts):
        with os.scandir(directory_fd) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            if excluded(name):
                continue
            if name in (".", "..") or "/" in name or "\\" in name:
                raise ArchiveError("A selected source entry has an unsafe archive name.")
            information = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            child_parts = (*parts, name)
            if stat.S_ISLNK(information.st_mode):
                raise ArchiveError("Symbolic links are not permitted in selected source.")
            if stat.S_ISDIR(information.st_mode):
                child = os.open(
                    name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd
                )
                try:
                    visit(child, child_parts)
                finally:
                    os.close(child)
            elif stat.S_ISREG(information.st_mode):
                capture(directory_fd, name, child_parts)
            else:
                raise ArchiveError("A selected source entry is not a regular file or directory.")

    root_fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in TOP_FILES:
            information = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            if not stat.S_ISREG(information.st_mode) or stat.S_ISLNK(information.st_mode):
                raise ArchiveError("A required source file is not a regular file.")
            capture(root_fd, name, (name,))
        for name in TOP_DIRECTORIES:
            information = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            if not stat.S_ISDIR(information.st_mode) or stat.S_ISLNK(information.st_mode):
                raise ArchiveError("A required source directory is unavailable or symbolic.")
            directory_fd = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd
            )
            try:
                visit(directory_fd, (name,))
            finally:
                os.close(directory_fd)
    finally:
        os.close(root_fd)
    return snapshots, total


def prepare_archive(output_directory):
    destination = Path(output_directory).absolute()
    if os.path.lexists(destination):
        raise ArchiveError("Choose a new output directory; existing paths are never overwritten.")
    snapshots, source_bytes = collect_sources()
    try:
        metadata = json.loads(snapshots["package.json"].decode("utf-8"))
        package_name = metadata["name"]
        version = metadata["version"]
        if not isinstance(package_name, str) or not re.fullmatch(
            r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*", package_name
        ):
            raise ValueError()
        if not isinstance(version, str) or not re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", version
        ):
            raise ValueError()
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ArchiveError("Source package metadata does not contain a safe name and version.") from None
    prefix = package_name.lstrip("@").replace("/", "-") + "-" + version
    inventory = [
        {"path": path, "bytes": len(payload), "sha256": sha256(payload)}
        for path, payload in sorted(snapshots.items())
    ]
    manifest = {
        "format": "investigator-source-archive-v1",
        "package": {"name": package_name, "version": version},
        "archivePrefix": prefix,
        "files": inventory,
        "sourceBytes": source_bytes,
        "contentDigest": {
            "algorithm": "sha256-of-canonical-inventory-v1",
            "sha256": sha256(canonical_json(inventory)),
        },
        "limits": {"fileBytes": MAX_FILE_BYTES, "totalBytes": MAX_TOTAL_BYTES},
        "limitations": [
            "This archive contains selected source and tests, not installed or built dependencies.",
            "Archive preparation does not execute tests, contact services, commit, publish, or submit.",
            "Checksums establish consistency with supplied hashes, not independently trusted authorship.",
            "The inventory excludes its generated manifest to avoid a self-referential digest.",
        ],
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(manifest_bytes) > MAX_FILE_BYTES or source_bytes + len(manifest_bytes) > MAX_TOTAL_BYTES:
        raise ArchiveError("Source and its generated manifest exceed the archive size limit.")
    archive_entries = {**snapshots, "source-manifest.json": manifest_bytes}
    buffer = io.BytesIO()
    # Fixed metadata and stable ordering make the same captured source reproducible.
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for path, payload in sorted(archive_entries.items()):
                entry = tarfile.TarInfo(prefix + "/" + path)
                entry.size = len(payload)
                entry.mode = 0o644
                entry.mtime = 0
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                archive.addfile(entry, io.BytesIO(payload))
    archive_bytes = buffer.getvalue()
    if len(archive_bytes) > MAX_TOTAL_BYTES:
        raise ArchiveError("The compressed source archive exceeds the 16 MiB output limit.")
    archive_name = prefix + "-source.tar.gz"
    # A racing/preexisting directory also fails this exclusive creation.
    destination.mkdir(mode=0o700)
    for name, payload in (
        (archive_name, archive_bytes),
        ("source-manifest.json", manifest_bytes),
        (
            "SHA256SUMS",
            (
                sha256(archive_bytes)
                + "  "
                + archive_name
                + "\n"
                + sha256(manifest_bytes)
                + "  source-manifest.json\n"
            ).encode("utf-8"),
        ),
    ):
        with (destination / name).open("xb") as output:
            output.write(payload)
    return {
        "format": "investigator-source-archive-result-v1",
        "directory": str(destination),
        "archive": archive_name,
        "files": len(inventory),
        "sourceBytes": source_bytes,
        "contentSha256": manifest["contentDigest"]["sha256"],
        "archiveSha256": sha256(archive_bytes),
        "testsExecuted": False,
        "published": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="New directory for source and checksums")
    arguments = parser.parse_args()
    try:
        result = prepare_archive(arguments.out)
    except ArchiveError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, tarfile.TarError):
        print(
            "Source preparation failed; check required regular files and a new writable output path.",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
