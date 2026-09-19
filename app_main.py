#!/usr/bin/env python3
"""Entry point for the packaged macOS .app.

Runs with --windowed under PyInstaller: there is no console, so stdout/stderr
are redirected to a log file before anything else can fail invisibly. Starts
server.py's HTTP server in a background thread, waits for it to answer, then
opens the browser on it. server.py itself still runs standalone exactly as in
S10 (`python3 server.py`); this file only adds what a double-clickable app
needs on top: picking a free port, logging, and opening the browser.
"""

import os
import socket
import sys
import threading
import time
import webbrowser

import server

FIRST_PORT = 8765
LAST_PORT = 8775
READY_TIMEOUT = 5.0  # seconds to wait for the server to answer


def _setup_logging():
    log_dir = os.path.join(os.path.expanduser("~/Library/Logs"), "escaner_disco")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "app.log")
    log = open(log_path, "w", buffering=1, encoding="utf-8")
    sys.stdout = log
    sys.stderr = log
    return log_path


def _pick_server():
    """Bind the first free port in [FIRST_PORT, LAST_PORT]; (httpd, port) or
    (None, None) if none is free."""
    for port in range(FIRST_PORT, LAST_PORT + 1):
        try:
            return server.make_server(port), port
        except OSError:
            continue
    return None, None


def _wait_ready(port, timeout=READY_TIMEOUT):
    """Poll until the port accepts connections, capped at `timeout` seconds
    (a short poll, not a fixed sleep: the server is usually ready in ms)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def main():
    log_path = _setup_logging()
    print(f"escaner_disco: starting, log at {log_path}")

    httpd, port = _pick_server()
    if httpd is None:
        print(f"escaner_disco: no free port in {FIRST_PORT}-{LAST_PORT}",
              file=sys.stderr)
        sys.exit(1)

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    if not _wait_ready(port):
        print(f"escaner_disco: server did not answer on port {port} "
              f"within {READY_TIMEOUT}s", file=sys.stderr)
        sys.exit(1)

    print(f"escaner_disco: serving on http://127.0.0.1:{port}/")
    webbrowser.open(f"http://127.0.0.1:{port}/")

    # Stay alive until /api/quit terminates the process (os._exit, see
    # server.py); the server thread only returns once shutdown() is called.
    thread.join()


if __name__ == "__main__":
    main()
