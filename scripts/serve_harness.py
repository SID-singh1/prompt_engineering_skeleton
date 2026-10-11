"""Serve extension/ for the harness pages, with caching off so edits show on reload.

    python scripts/serve_harness.py            # http://localhost:8765/tests/pill-harness.html
    python scripts/serve_harness.py 9000       # another port

Add ?anon=1 to the harness URL to try the free tier (no account, no key).
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "extension"


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCache, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{port}/tests/pill-harness.html")
        httpd.serve_forever()
