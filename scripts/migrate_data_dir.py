#!/usr/bin/env python3
"""Migrate pi2web server data from the old ``~/.pi/remote-pi`` directory to ``~/.pi/pi2web``.

pi2web no longer reads the old location, so run this once (with the pi2web server stopped):

    python scripts/migrate_data_dir.py            # copy ~/.pi/remote-pi -> ~/.pi/pi2web
    python scripts/migrate_data_dir.py --dry-run  # only show what would happen

What it does:
  * ``remote-pi.db`` is copied with SQLite's online backup API into ``pi2web.db``. The backup includes
    anything still sitting in ``remote-pi.db-wal``, so the ``-wal`` / ``-shm`` side files are not copied.
  * Every other file and directory (``auth.json`` with the pairing-code hashes, ...) is copied unchanged.
  * The source directory is left untouched; delete it yourself once the new server works.

If the target already contains files that would be overwritten, the script stops unless ``--force`` is
given; with ``--force`` the conflicting files are first moved into ``<target>/pre-migration-<timestamp>/``.
Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

OLD_DB = "remote-pi.db"
NEW_DB = "pi2web.db"
SQLITE_SIDE_SUFFIXES = ("-wal", "-shm", "-journal")


def default_dir(name: str) -> Path:
    return Path.home() / ".pi" / name


def plan(source: Path) -> list[tuple[Path, str, str]]:
    """Return (source path, relative target path, kind) for everything that must be migrated."""
    items: list[tuple[Path, str, str]] = []
    for entry in sorted(source.iterdir()):
        name = entry.name
        if name == OLD_DB:
            items.append((entry, NEW_DB, "sqlite"))
        elif any(name == OLD_DB + suffix for suffix in SQLITE_SIDE_SUFFIXES):
            continue  # folded into the backup of remote-pi.db
        elif any(name == NEW_DB + suffix for suffix in ("",) + SQLITE_SIDE_SUFFIXES):
            print(f"  ! skipping {name}: the source already has a pi2web database file", file=sys.stderr)
        elif entry.is_dir():
            items.append((entry, name, "dir"))
        else:
            items.append((entry, name, "file"))
    return items


def target_conflicts(target: Path, items: list[tuple[Path, str, str]]) -> list[Path]:
    conflicts: list[Path] = []
    for _, rel, kind in items:
        dest = target / rel
        if dest.exists():
            conflicts.append(dest)
        if kind == "sqlite":
            conflicts += [p for p in (target / (rel + s) for s in SQLITE_SIDE_SUFFIXES) if p.exists()]
    # A database left in the target under the *old* name would be ignored by pi2web but is confusing.
    conflicts += [p for p in (target / (OLD_DB + s) for s in ("",) + SQLITE_SIDE_SUFFIXES) if p.exists()]
    return sorted(set(conflicts))


def backup_sqlite(src: Path, dest: Path) -> dict[str, int]:
    # Read-only URI: never let the migration modify the source database.
    source = sqlite3.connect(f"{src.resolve().as_uri()}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
            target.execute("PRAGMA journal_mode = WAL")
            result = target.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError(f"integrity check failed on {dest}: {result}")
            counts = {}
            tables = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ("workspaces", "agents", "sessions", "settings"):
                if table in tables:
                    counts[table] = target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            target.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return counts
        finally:
            target.close()
    finally:
        source.close()


def restrict(path: Path, mode: int) -> None:
    if os.name != "nt":
        try:
            path.chmod(mode)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", type=Path, default=default_dir("remote-pi"),
                        help="old data directory (default: ~/.pi/remote-pi)")
    parser.add_argument("--to", dest="target", type=Path, default=default_dir("pi2web"),
                        help="new data directory (default: ~/.pi/pi2web)")
    parser.add_argument("--dry-run", action="store_true", help="show the plan without writing anything")
    parser.add_argument("--force", action="store_true",
                        help="move conflicting files in the target aside instead of aborting")
    args = parser.parse_args()
    source: Path = args.source.expanduser()
    target: Path = args.target.expanduser()

    if not source.is_dir():
        print(f"Nothing to migrate: {source} does not exist.")
        return 0
    if source.resolve() == target.resolve():
        print("Source and target are the same directory.", file=sys.stderr)
        return 2

    items = plan(source)
    if not items:
        print(f"Nothing to migrate: {source} is empty.")
        return 0
    print(f"Migrating {source} -> {target}")
    for src, rel, kind in items:
        note = " (SQLite backup, includes WAL)" if kind == "sqlite" else "/" if kind == "dir" else ""
        print(f"  {src.name} -> {rel}{note}")

    conflicts = target_conflicts(target, items) if target.exists() else []
    stash: Path | None = None
    if conflicts:
        print("Target already contains:")
        for path in conflicts:
            print(f"  {path}")
        if not args.force:
            print("Aborting. Re-run with --force to move these into a pre-migration backup folder.",
                  file=sys.stderr)
            return 1
        stash = target / time.strftime("pre-migration-%Y%m%d-%H%M%S")
        print(f"They will be moved to {stash}")

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0

    print("Make sure the pi2web / Remote Pi server is stopped before continuing.")
    target.mkdir(parents=True, exist_ok=True)
    restrict(target, 0o700)
    if stash:
        stash.mkdir()
        for path in conflicts:
            shutil.move(str(path), str(stash / path.name))

    for src, rel, kind in items:
        dest = target / rel
        if kind == "sqlite":
            counts = backup_sqlite(src, dest)
            restrict(dest, 0o600)
            summary = ", ".join(f"{k}={v}" for k, v in counts.items()) or "no known tables"
            print(f"  ✓ {rel} ({summary})")
        elif kind == "dir":
            shutil.copytree(src, dest)
            print(f"  ✓ {rel}/")
        else:
            shutil.copy2(src, dest)
            if rel == "auth.json":
                restrict(dest, 0o600)
            print(f"  ✓ {rel}")

    print(f"Done. Start pi2web (it now uses {target}); once everything works you can delete {source}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
