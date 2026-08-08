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
import heapq
import json
import os
import sys
import time

import platform_support

# Per junk category, keep at most this many of the largest detected paths. The
# counter (n_paths) stays exact; only the stored list is capped, same idea as
# MAX_ERROR_PATHS. Without a cap a disk with hundreds of node projects would put
# hundreds of long paths into RAM and the .json.gz.
MAX_JUNK_PATHS = 20

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


# --- Junk (regenerable folder) detection -----------------------------------
# Rule lookup tables, built once from the platform catalogue. Names compare
# case-per-OS (norm); paths compare with normcase on both sides (spec 1.5).

def _build_junk_maps():
    name_map, path_map = {}, {}
    for rule in platform_support.junk_rules():
        if rule["kind"] == "name":
            m = rule["match"]
            for n in (m if isinstance(m, tuple) else (m,)):
                name_map[platform_support.norm(n)] = rule
        else:
            path_map[os.path.normcase(rule["match"])] = rule
    return name_map, path_map


_JUNK_NAME_MAP, _JUNK_PATH_MAP = _build_junk_maps()


def _match_junk(name, path):
    """Return the rule a directory matches, or None. Cheap: two dict lookups."""
    rule = _JUNK_NAME_MAP.get(platform_support.norm(name))
    if rule is not None:
        return rule
    return _JUNK_PATH_MAP.get(os.path.normcase(path))


class JunkCollector:
    """Accumulates per-category size/count of detected junk directories.

    A directory is recorded once, on close, with its whole subtree size. The
    counter is exact; the stored path list is capped at MAX_JUNK_PATHS (largest
    kept via a min-heap, so pushing past the cap is O(1) amortised).
    """
    __slots__ = ("_cats",)

    def __init__(self):
        self._cats = {}  # rule_id -> {"rule", "total_size", "n_paths", "heap"}

    def record(self, rule, path, size, n_files):
        c = self._cats.get(rule["id"])
        if c is None:
            c = self._cats[rule["id"]] = {
                "rule": rule, "total_size": 0, "n_paths": 0, "heap": [],
            }
        c["total_size"] += size
        c["n_paths"] += 1
        item = (size, path, n_files)
        heap = c["heap"]
        if len(heap) < MAX_JUNK_PATHS:
            heapq.heappush(heap, item)
        else:
            heapq.heappushpop(heap, item)  # drops the current smallest

    def result(self):
        """Serialisable summary. Categories with no detection never appear."""
        cats = []
        for c in self._cats.values():
            rule = c["rule"]
            paths = sorted(c["heap"], key=lambda t: t[0], reverse=True)
            cats.append({
                "id": rule["id"],
                "label": rule["label"],
                "why": rule["why"],
                "total_size": c["total_size"],
                "n_paths": c["n_paths"],
                "truncated": c["n_paths"] > MAX_JUNK_PATHS,
                "paths": [{"path": p, "size": s, "n_files": nf}
                          for (s, p, nf) in paths],
            })
        cats.sort(key=lambda x: x["total_size"], reverse=True)
        return {"categories": cats,
                "total_size": sum(x["total_size"] for x in cats)}


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


def _warn_if_no_descent(root, root_node):
    """Guard against a silently empty scan.

    A scan that never descended looks identical to a correct scan of a tiny
    flat folder (the S8 Windows bug produced 22 files, 0 errors, no trace). If
    the root has at least one subdirectory but none was walked, warn loudly on
    stderr. This only warns: it never aborts nor changes the exit code.
    """
    if any(c.is_dir for c in (root_node.children or [])):
        return  # at least one subdirectory made it into the tree
    try:
        with os.scandir(platform_support.extended_path(root)) as it:
            has_subdir = any(e.is_dir(follow_symlinks=False) for e in it)
    except OSError:
        return  # can't tell; stay quiet rather than cry wolf
    if has_subdir:
        print(f"WARNING: scan of {root!r} did not descend into any of its "
              "subdirectories. The result is almost certainly incomplete.",
              file=sys.stderr)


def scan(root, excludes=None, callback=None):
    """Scan root and return (root_node, stats).

    callback(files_seen, current_path) is invoked every 20,000 entries.
    """
    root = os.path.abspath(root)
    src = platform_support.default_excludes() if excludes is None else excludes
    excludes = {platform_support.norm(p) for p in src}

    stats = {"files": 0, "errors": 0, "seconds": 0.0, "error_paths": []}
    seen_inodes = set()  # (st_dev, st_ino) for hardlink dedup
    junk = JunkCollector()
    started = time.time()

    def record_error(path):
        stats["errors"] += 1
        if len(stats["error_paths"]) < MAX_ERROR_PATHS:
            stats["error_paths"].append(platform_support.strip_extended(path))

    try:
        root_st = os.stat(root, follow_symlinks=False)
    except OSError as exc:
        raise SystemExit(f"Cannot stat root {root}: {exc}")

    root_node = Node(os.path.basename(root) or root, 0, 0, True, [])

    # Frame: [node, entries, idx, dirpath, inside_junk, rule, jpath]. entries is
    # None until listed. dirpath feeds os.scandir and the exclude/volume checks
    # and is never stored on the Node. The last three carry junk accounting:
    # inside_junk is True once we are within a detected subtree (so we stop
    # evaluating rules), rule/jpath name the category this exact directory is,
    # and are non-None only on the subtree's top directory. On Windows the walk
    # root carries the \\?\ long-path prefix (stripped from client-facing paths).
    stack = [[root_node, None, 0, platform_support.extended_path(root),
              False, None, None]]

    while stack:
        frame = stack[-1]
        node, entries, idx, dpath = frame[:4]

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
            # Post-order: size/count are accumulated now, so record this dir in
            # its category (only the subtree's top dir has a non-None rule).
            if frame[5] is not None:
                junk.record(frame[5], frame[6], node.size, node.n_files)
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
            # Volume boundary check is platform-specific: on Windows scandir
            # leaves st_dev at 0, so a raw st_dev compare drops every subdir.
            if not platform_support.same_volume(root, root_st, clean, st):
                continue  # do not cross volumes
            child = Node(entry.name, 0, 0, True, [])
            node.children.append(child)
            # Pre-order junk marking. Inside a detected subtree we inherit the
            # flag and stop evaluating, so nested junk (a node_modules within a
            # node_modules) is never counted twice. Otherwise test the rules.
            if frame[4]:  # parent already inside junk
                stack.append([child, None, 0, entry.path, True, None, None])
            else:
                rule = _match_junk(entry.name, clean)
                stack.append([child, None, 0, entry.path,
                              rule is not None, rule,
                              clean if rule is not None else None])
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

    _warn_if_no_descent(root, root_node)
    stats["seconds"] = time.time() - started
    stats["junk"] = junk.result()
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

    _print_junk(stats.get("junk"))


def _print_junk(junk):
    """Compact regenerable-data section, sorted by size desc. Silent if empty."""
    if not junk or not junk["categories"]:
        return
    cats = junk["categories"]
    n = len(cats)
    print(f"\nRegenerable data: {human(junk['total_size'])} in {n} "
          f"{'category' if n == 1 else 'categories'}")
    for c in cats:
        d = c["n_paths"]
        print(f"  {c['label']:<22} {human(c['total_size']):>8} "
              f"{d:>5} {'dir' if d == 1 else 'dirs'}")


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
