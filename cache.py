#!/usr/bin/env python3
"""On-disk cache for scanned trees, so we don't rescan on every startup.

The cache lives in the app's OWN directory under Application Support, never
inside the project: a cache file is a full map of the names of the user's
folders. Format is json + gzip (both stdlib). Never pickle: unpickling executes
code, and this tool cannot afford that risk even in a file it wrote itself.

The tree is serialized compactly (short keys, defaults omitted) so a 200-400k
node scan fits in a few MB instead of tens of MB.
"""

import gzip
import hashlib
import io
import json
import os
import sys

import scanner

FORMAT_VERSION = 1
_TREE_MARKER = ',"tree":'  # top-level "tree" key is written LAST (see _write)


def cache_dir():
    """Absolute path of the app's cache directory (not created here)."""
    base = os.path.expanduser("~/Library/Application Support")
    return os.path.join(base, "escaner_disco")


def _ensure_dir():
    d = cache_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    try:
        os.chmod(d, 0o700)  # enforce 0700 even if umask cleared bits at creation
    except OSError:
        pass
    return d


def _abs(root_path):
    # expanduser first: os.path.abspath does NOT expand ~, it would resolve it
    # against the cwd and break the hash match between save and load.
    return os.path.abspath(os.path.expanduser(root_path))


def _path_for(root_path):
    # One file per scanned path (so several caches can coexist). The original
    # path lives INSIDE the JSON; the filename is just a stable hash of it.
    digest = hashlib.sha256(_abs(root_path).encode("utf-8")).hexdigest()
    return os.path.join(cache_dir(), digest[:16] + ".json.gz")


# --- Compact tree (de)serialization ---------------------------------------
# Node -> {"n":name, "s":size, "f":n_files, "d":is_dir, "u":unreadable,
#          "y":synthetic, "c":[children]}, omitting keys at their default.

def _write_tree(node, out):
    out.write('{"n":')
    out.write(json.dumps(node.name, ensure_ascii=False))
    if node.size:
        out.write(',"s":' + str(node.size))
    if node.n_files:
        out.write(',"f":' + str(node.n_files))
    if node.is_dir:
        out.write(',"d":1')
    if node.unreadable:
        out.write(',"u":1')
    if scanner._is_synthetic(node):
        out.write(',"y":1')
    if node.children:
        out.write(',"c":[')
        for i, child in enumerate(node.children):
            if i:
                out.write(',')
            _write_tree(child, out)
        out.write(']')
    out.write('}')


def _read_tree(d):
    if "c" in d:
        children = [_read_tree(c) for c in d["c"]]
    elif d.get("d") and not d.get("u"):
        children = []          # readable dir, empty
    else:
        children = None        # file, synthetic, or unreadable dir
    return scanner.Node(
        d["n"], d.get("s", 0), d.get("f", 0),
        bool(d.get("d")), children, bool(d.get("u")),
    )


# --- Public API ------------------------------------------------------------

def save(root_path, tree, meta):
    """Write the cache file for root_path. Returns its path.

    meta carries scanned_at, elapsed, errors and error_paths; the totals come
    from the tree itself so they cannot disagree with it.
    """
    _ensure_dir()
    fpath = _path_for(root_path)
    # fs trees can nest ~thousands deep; raise the limit for the recursive dump.
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 40000))

    # Create with 0600 up front so the map of folder names is never briefly
    # world-readable. Tree is written LAST so _read_header can stop early.
    fd = os.open(fpath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as raw, \
            gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz, \
            io.TextIOWrapper(gz, encoding="utf-8") as out:
        head = {
            "format_version": FORMAT_VERSION,
            "root_path": _abs(root_path),
            "scanned_at": meta["scanned_at"],
            "elapsed": meta["elapsed"],
            "total_size": tree.size,
            "n_files": tree.n_files,
            "errors": meta["errors"],
            "error_paths": meta["error_paths"],
            "max_children": scanner.MAX_CHILDREN,
        }
        # Emit the head object without its closing brace, then ,"tree":<tree>}.
        head_json = json.dumps(head, ensure_ascii=False)
        out.write(head_json[:-1])  # drop trailing "}"
        out.write(_TREE_MARKER)
        _write_tree(tree, out)
        out.write('}')
    try:
        os.chmod(fpath, 0o600)
    except OSError:
        pass
    return fpath


def _read_header(fpath):
    """Parse only the top-level scalar fields, without decoding the tree."""
    buf = ""
    with gzip.open(fpath, "rt", encoding="utf-8") as f:
        while _TREE_MARKER not in buf:
            chunk = f.read(8192)
            if not chunk:
                break
            buf += chunk
    idx = buf.find(_TREE_MARKER)
    if idx == -1:
        raise ValueError("no tree marker")
    return json.loads(buf[:idx] + "}")


def load(root_path):
    """Return (tree, meta) for root_path, or None if absent/invalid.

    A file that exists but is stale (wrong format_version or a different
    MAX_CHILDREN than the current code) is ignored with a warning: pruning at
    scan time (S2) means a cache built with another cap cannot be trusted.
    """
    fpath = _path_for(root_path)
    if not os.path.isfile(fpath) or os.path.islink(fpath):
        return None
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 40000))
    try:
        with gzip.open(fpath, "rt", encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, ValueError) as exc:
        print(f"cache: ignoring unreadable {fpath}: {exc}", file=sys.stderr)
        return None

    if obj.get("format_version") != FORMAT_VERSION:
        print(f"cache: ignoring {fpath}: format_version "
              f"{obj.get('format_version')} != {FORMAT_VERSION}", file=sys.stderr)
        return None
    if obj.get("max_children") != scanner.MAX_CHILDREN:
        print(f"cache: ignoring {fpath}: max_children "
              f"{obj.get('max_children')} != {scanner.MAX_CHILDREN} "
              f"(rescan needed)", file=sys.stderr)
        return None

    tree = _read_tree(obj["tree"])
    meta = {
        "root_path": obj.get("root_path", _abs(root_path)),
        "scanned_at": obj.get("scanned_at", 0),
        "elapsed": obj.get("elapsed", 0),
        "total_size": obj.get("total_size", tree.size),
        "n_files": obj.get("n_files", tree.n_files),
        "errors": obj.get("errors", 0),
        "error_paths": obj.get("error_paths", []),
    }
    return tree, meta


def list_entries():
    """List saved caches (newest first), reading only each file's header."""
    d = cache_dir()
    entries = []
    if not os.path.isdir(d):
        return entries
    for name in os.listdir(d):
        if not name.endswith(".json.gz"):
            continue
        fpath = os.path.join(d, name)
        if os.path.islink(fpath) or not os.path.isfile(fpath):
            continue
        try:
            head = _read_header(fpath)
            entries.append({
                "path": head.get("root_path"),
                "scanned_at": head.get("scanned_at"),
                "size_on_disk": os.path.getsize(fpath),
                "total_size": head.get("total_size"),
                "n_files": head.get("n_files"),
            })
        except (OSError, ValueError):
            continue  # skip corrupt/unreadable files
    entries.sort(key=lambda e: e.get("scanned_at") or 0, reverse=True)
    return entries


def clear_all():
    """Delete every cache file. Returns the number deleted.

    This is the only function that deletes, so it is written defensively:
      * It takes NO argument. Nothing can ask it to delete anything else.
      * It only touches *.json.gz files strictly inside cache_dir(); anything
        else in that folder is left alone.
      * It removes files one by one with os.remove(). Never shutil.rmtree() —
        an rmtree with the wrong variable is a catastrophe, and there is no need
        to take that risk.
      * It skips symlinks, so it cannot be tricked into deleting through a link
        that points out of the directory.
      * It catches OSError per file, counts the deletions and keeps going.
    """
    d = cache_dir()
    if not os.path.isdir(d):
        return 0
    deleted = 0
    for name in os.listdir(d):
        if not name.endswith(".json.gz"):
            continue
        fpath = os.path.join(d, name)
        if os.path.islink(fpath):
            continue
        try:
            os.remove(fpath)
            deleted += 1
        except OSError:
            continue
    return deleted
