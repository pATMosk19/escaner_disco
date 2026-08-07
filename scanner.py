#!/usr/bin/env python3
"""Iterative disk usage scanner (cross-platform, stdlib only).

Builds an in-memory tree of real on-disk sizes. Read-only: never deletes,
moves or modifies anything. Iterative (explicit stack) to survive very deep
paths without RecursionError.

Nodes are `Node` objects with `__slots__` and store only the entry name (not
the full path) to keep memory down; the path is reconstructed with
os.path.join while walking down from the scan root.

Everything OS-specific (default root, exclusions, on-disk size measurement)
lives in platform_support; this module stays platform-agnostic. Permissions
needed to scan outside your home folder differ per OS — see the README.
"""

import argparse
import json
import os
import sys
import time

import platform_support

# Max direct children kept per directory. The rest are collapsed into a single
# synthetic "Otros" node AT SCAN TIME and their subtrees are discarded (that is
# the bulk of the memory saving). Raising this requires re-scanning.
MAX_CHILDREN = 40

# Keep at most this many failed paths (the total is still counted). A scan with
# 50k permission errors must not undo the memory we just saved.
MAX_ERROR_PATHS = 1000

# Synthetic aggregate node name prefix. Used to re-detect it on serialization
# without spending a slot on a boolean flag.
# ponytail: name-prefix sniff; a real file named "Otros (…)" would be
# misrendered as synthetic (cosmetic only). Add a slot if it ever matters.
OTHERS_PREFIX = "Otros ("


class Node:
    __slots__ = ("name", "size", "n_files", "is_dir", "children", "unreadable")

    def __init__(self, name, size, n_files, is_dir, children, unreadable=False):
        self.name = name
        self.size = size
        self.n_files = n_files
        self.is_dir = is_dir
        self.children = children  # list for dirs, None for files/leaves
        self.unreadable = unreadable


def human(size):
    """Human-readable size, base 1000 (matches Finder)."""
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    value = float(size)
    for unit in units:
        if value < 1000 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1000


def _excluded(path, root, excludes):
    """True if path must be skipped. `excludes` is already case-normalised."""
    if platform_support.norm(path) in excludes:
        return True
    # OS-specific quirks (firmlink double-count, .Snapshot, Windows junk).
    return platform_support.excluded_here(path, root)


def _finalize(node):
    """Accumulate child sizes into `node`, then sort and prune its children.

    Sizes/counts are summed over ALL children first (the scan total must not
    change), then the tail beyond MAX_CHILDREN is collapsed into one synthetic
    node and the discarded subtrees are dropped.
    """
    kids = node.children
    node.size = sum(c.size for c in kids)
    node.n_files = sum(c.n_files for c in kids)
    kids.sort(key=lambda c: c.size, reverse=True)

    if len(kids) > MAX_CHILDREN:
        rest = kids[MAX_CHILDREN:]
        del kids[MAX_CHILDREN:]
        kids.append(Node(
            f"{OTHERS_PREFIX}{len(rest)} elementos)",
            sum(c.size for c in rest),
            sum(c.n_files for c in rest),
            False, None,
        ))


def scan(root, excludes=None, callback=None):
    """Scan root and return (root_node, stats).

    callback(files_seen, current_path) is invoked every 20,000 entries.
    """
    root = os.path.abspath(root)
    src = platform_support.default_excludes() if excludes is None else excludes
    excludes = {platform_support.norm(p) for p in src}

    stats = {"files": 0, "errors": 0, "seconds": 0.0, "error_paths": []}
    seen_inodes = set()  # (st_dev, st_ino) for hardlink dedup
    started = time.time()

    def record_error(path):
        stats["errors"] += 1
        if len(stats["error_paths"]) < MAX_ERROR_PATHS:
            stats["error_paths"].append(platform_support.strip_extended(path))

    try:
        root_st = os.stat(root, follow_symlinks=False)
    except OSError as exc:
        raise SystemExit(f"Cannot stat root {root}: {exc}")
    root_dev = root_st.st_dev

    root_node = Node(os.path.basename(root) or root, 0, 0, True, [])

    # Frame: [node, entries, idx, dirpath]. entries is None until listed.
    # dirpath is kept only to feed os.scandir and the exclude/volume checks;
    # it is never stored on the Node. On Windows the walk root carries the
    # \\?\ long-path prefix (stripped from anything shown to the client).
    stack = [[root_node, None, 0, platform_support.extended_path(root)]]

    while stack:
        frame = stack[-1]
        node, entries, idx, dpath = frame

        if entries is None:
            try:
                entries = []
                with os.scandir(dpath) as it:
                    for entry in it:
                        entries.append(entry)
                frame[1] = entries
            except (PermissionError, OSError):
                # Can't open this directory: keep it as an unreadable node so
                # the loss is visible, and stop descending.
                record_error(dpath)
                node.unreadable = True
                node.children = None
                stack.pop()
            continue

        if idx >= len(entries):
            _finalize(node)
            stack.pop()
            continue

        entry = entries[idx]
        frame[2] += 1
        stats["files"] += 1
        if stats["files"] % 20000 == 0 and callback:
            callback(stats["files"], platform_support.strip_extended(entry.path))

        try:
            st = entry.stat(follow_symlinks=False)
        except (PermissionError, OSError):
            record_error(entry.path)
            continue

        if entry.is_symlink():
            node.children.append(Node(entry.name, 0, 1, False, None))
            continue

        # Clean path (no \\?\ prefix) for exclusion/comparison; entry.path keeps
        # the prefix so os.scandir keeps working past 260 chars on Windows.
        clean = platform_support.strip_extended(entry.path)

        if entry.is_dir(follow_symlinks=False):
            if _excluded(clean, root, excludes):
                continue
            if st.st_dev != root_dev:
                continue  # do not cross volumes
            child = Node(entry.name, 0, 0, True, [])
            node.children.append(child)
            stack.append([child, None, 0, entry.path])
            continue

        # Files can also be excluded (Windows pagefile.sys, hiberfil.sys, ...).
        if platform_support.excluded_here(clean, root):
            continue

        # Regular file: count once, dedup hardlinks. st_ino can be 0 on some
        # filesystems; when it is, dedup is impossible, so count the file.
        if st.st_nlink > 1 and st.st_ino != 0:
            key = (st.st_dev, st.st_ino)
            if key in seen_inodes:
                node.children.append(Node(entry.name, 0, 1, False, None))
                continue
            seen_inodes.add(key)
        size = platform_support.disk_size(st, entry.path)
        node.children.append(Node(entry.name, size, 1, False, None))

    stats["seconds"] = time.time() - started
    return root_node, stats


def _join(path, name):
    # os.path.join handles the drive-root case (C:\ + Users -> C:\Users) that
    # naive "path + sep + name" would turn into a relative "C:Users".
    return os.path.join(path, name)


def _is_synthetic(node):
    return (not node.is_dir and node.children is None
            and node.name.startswith(OTHERS_PREFIX))


def to_dict(node, path, depth=None):
    """Serialize a Node subtree to plain dicts, reconstructing paths.

    depth=None serializes the whole subtree; a number prunes to that many
    levels, marking cut dirs with truncated=True so the client can ask for more.
    """
    d = {
        "name": node.name,
        "path": path,
        "size": node.size,
        "is_dir": node.is_dir,
        "n_files": node.n_files,
    }
    if node.unreadable:
        d["unreadable"] = True
    if _is_synthetic(node):
        d["synthetic"] = True

    if node.children is None:
        d["children"] = []
        return d
    if depth is not None and depth <= 0:
        d["children"] = []
        d["truncated"] = True
        return d

    nd = None if depth is None else depth - 1
    d["children"] = [to_dict(c, _join(path, c.name), nd) for c in node.children]
    return d


def _print_summary(root_path, node, stats):
    total = node.size
    print(f"\n{root_path}")
    print(f"Total: {human(total)}  ({node.n_files} files, "
          f"{stats['errors']} errors, {stats['seconds']:.1f}s)\n")
    print("Top 20:")
    for child in node.children[:20]:
        pct = (child.size / total * 100) if total else 0
        kind = "/" if child.is_dir else " "
        print(f"  {human(child.size):>10}  {pct:5.1f}%  {child.name}{kind}")

    if stats["errors"]:
        print("\nUnreadable paths:")
        for path in stats["error_paths"][:10]:
            print(f"  {path}")
        if stats["errors"] > 10:
            print(f"  ... y {stats['errors'] - 10} más")


def main():
    notes = {
        "macos": "To scan outside your home folder, grant Full Disk Access to "
                 "the launching app (Terminal, iTerm, VS Code) in System "
                 "Settings -> Privacy & Security -> Full Disk Access.",
        "windows": "To scan protected system areas, run this from an elevated "
                   "(Administrator) command prompt.",
        "linux": "To scan paths you don't own, run with sufficient privileges "
                 "(e.g. sudo).",
    }
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=notes.get(platform_support.platform_id(), notes["linux"]),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("path", help="Directory to scan")
    parser.add_argument("--json", metavar="FILE",
                        help="Write full tree as JSON to FILE instead of "
                             "printing the top 20")
    args = parser.parse_args()

    def progress(files_seen, current_path):
        print(f"\r{files_seen} files... {current_path[:60]}",
              end="", file=sys.stderr, flush=True)

    root_path = os.path.abspath(os.path.expanduser(args.path))
    node, stats = scan(root_path, callback=progress)
    print("", file=sys.stderr)  # newline after progress

    if args.json:
        # ponytail: recursive dump; fs nesting is ~thousands deep at most, so
        # raise the limit rather than write an iterative serializer for a
        # dev-only convenience.
        sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))
        with open(args.json, "w") as fh:
            json.dump(to_dict(node, root_path), fh)
        print(f"Wrote {args.json} "
              f"({human(node.size)}, {node.n_files} files)")
    else:
        _print_summary(root_path, node, stats)


if __name__ == "__main__":
    main()
