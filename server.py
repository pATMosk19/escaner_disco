#!/usr/bin/env python3
"""Local HTTP server for the disk scanner. Read-only, 127.0.0.1 only.

The scan tree lives in memory and is never serialized whole to the client:
/api/node returns a depth-pruned subtree on demand.
"""

import argparse
import json
import mimetypes
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import scanner

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_DEPTH = 5

# Shared scan state, guarded by _lock.
# ponytail: single global scan; the app scans one tree at a time by design.
_lock = threading.Lock()
_state = {
    "state": "idle",       # idle | scanning | done | error
    "root": "",            # absolute root path of the current/last scan
    "files_seen": 0,
    "current_path": "",
    "elapsed": 0.0,
    "errors": 0,
    "message": "",
}
_tree = None          # root Node of the last completed scan
_root_path = ""       # absolute path of that root
_error_paths = []     # capped list of unreadable paths from the last scan
_error_total = 0      # total unreadable paths (may exceed the capped list)


def _run_scan(path):
    global _tree, _root_path, _error_paths, _error_total
    started = time.time()

    def progress(files_seen, current_path):
        with _lock:
            _state["files_seen"] = files_seen
            _state["current_path"] = current_path
            _state["elapsed"] = time.time() - started

    try:
        tree, stats = scanner.scan(path, callback=progress)
        with _lock:
            _tree = tree
            _root_path = os.path.abspath(path)
            _error_paths = stats["error_paths"]
            _error_total = stats["errors"]
            _state.update({
                "state": "done",
                "files_seen": stats["files"],
                "current_path": "",
                "elapsed": stats["seconds"],
                "errors": stats["errors"],
                "message": "",
            })
    except Exception as exc:  # keep server alive on any scan failure
        with _lock:
            _state.update({"state": "error", "message": str(exc)})


def _find(path):
    """Walk the tree from the root to the Node at `path`, or None."""
    if _tree is None or not path.startswith(_root_path):
        return None
    rel = path[len(_root_path):].strip("/")
    node = _tree
    if not rel:
        return node
    for seg in rel.split("/"):
        if node.children is None:
            return None
        node = next((c for c in node.children if c.name == seg), None)
        if node is None:
            return None
    return node


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, path):
        # Map URL path to a file under STATIC_DIR, no traversal.
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/progress":
            with _lock:
                self._send_json(dict(_state))
            return
        if parsed.path == "/api/node":
            self._handle_node(parsed)
            return
        if parsed.path == "/api/errors":
            with _lock:
                self._send_json({
                    "total": _error_total,
                    "truncated": _error_total > scanner.MAX_ERROR_PATHS,
                    "paths": list(_error_paths),
                })
            return
        if parsed.path == "/api/reveal":
            # Reveal is POST-only. A GET would be trivially triggerable by any
            # web page via <img src="http://127.0.0.1:8765/api/reveal?path=...">,
            # so refuse it outright instead of falling through to a 404.
            self._send_json({"ok": False, "error": "method not allowed"},
                            status=405)
            return
        self._send_static(parsed.path)

    def _handle_node(self, parsed):
        qs = parse_qs(parsed.query)
        path = unquote(qs.get("path", [""])[0])
        depth = int(qs.get("depth", ["3"])[0])
        depth = max(1, min(MAX_DEPTH, depth))
        with _lock:
            node = _find(path)
            if node is None:
                self._send_json({"error": "not found"}, status=404)
                return
            self._send_json(scanner.to_dict(node, path, depth))

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/scan":
            self._handle_scan()
            return
        if parsed.path == "/api/reveal":
            self._handle_reveal()
            return
        self.send_error(404)

    def _handle_scan(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or "{}")
            path = os.path.expanduser(body.get("path", ""))
        except (ValueError, TypeError):
            self._send_json({"error": "bad request"}, status=400)
            return
        if not path or not os.path.isdir(path):
            self._send_json({"error": "not a directory"}, status=400)
            return

        with _lock:
            if _state["state"] == "scanning":
                self._send_json({"error": "scan in progress"}, status=409)
                return
            _state.update({
                "state": "scanning", "root": os.path.abspath(path),
                "files_seen": 0, "current_path": "",
                "elapsed": 0.0, "errors": 0, "message": "",
            })
        threading.Thread(target=_run_scan, args=(path,), daemon=True).start()
        self._send_json({"state": "scanning"}, status=202)

    def _handle_reveal(self):
        # This is the ONLY endpoint with a side effect: it opens a Finder
        # window for a scanned path. The server listens on 127.0.0.1 with no
        # auth, so any web page in another browser tab can POST here. For a
        # read-only endpoint that only leaks the tree; one that spawns a process
        # needs a higher bar. Every check below closes a specific hole:
        #
        #  1. POST-only is enforced in do_GET (405): a GET is reachable from a
        #     bare <img>/<link> tag with no script and no user gesture.
        #  2. Origin: if the browser sent one and it is not our own page, this
        #     is a cross-site request -> 403. A missing Origin is allowed,
        #     because same-origin fetch/XHR does not always attach one.
        #  3. The path must be a node the last scan produced (resolved by
        #     walking the tree, exactly like /api/node). We never pass an
        #     arbitrary filesystem path to `open`; only one the scan surfaced.
        #     Anything else -> 404 and nothing runs. This is the main defense.
        #  4. Synthetic "Otros (N elementos)" nodes have no real path behind
        #     them -> 400.
        #  5. Execution is `open -R` with an argument list and a timeout, never
        #     shell=True and never plain `open`. Plain `open` would LAUNCH the
        #     file's associated app; `-R` only REVEALS it in Finder. That single
        #     flag is the line between a convenience and a remote-exec hole.
        host, port = self.server.server_address
        allowed_origin = f"http://{host}:{port}"

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""  # drain the body

        origin = self.headers.get("Origin")
        if origin is not None and origin != allowed_origin:
            self._send_json({"ok": False, "error": "forbidden origin"},
                            status=403)
            return

        try:
            path = json.loads(raw or b"{}").get("path", "")
        except (ValueError, TypeError):
            self._send_json({"ok": False, "error": "bad request"}, status=400)
            return

        with _lock:
            node = _find(path)
            if node is None:
                self._send_json({"ok": False, "error": "path not in scan"},
                                status=404)
                return
            if scanner._is_synthetic(node):
                self._send_json({"ok": False, "error": "synthetic node"},
                                status=400)
                return

        try:
            subprocess.run(["open", "-R", path], timeout=5)
        except (subprocess.SubprocessError, OSError) as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=500)
            return
        self._send_json({"ok": True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Serving on http://127.0.0.1:{args.port}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye")


if __name__ == "__main__":
    main()
