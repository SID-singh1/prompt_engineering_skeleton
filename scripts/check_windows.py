"""The first-run tips and the card, as a Windows user sees them.

Runs the real content.js in extension/tests/pill-harness.html with the page
told it is on Windows (navigator.platform "Win32", a Windows user agent), and
checks the things that differ there:

  - every key name reads Ctrl+…, never the Mac symbols;
  - the tips name the shortcut Chrome actually assigned, and when Chrome left
    it unassigned (another extension already had Ctrl+Shift+E, common on
    Windows) they say so and offer to set one, instead of naming a key that
    goes to someone else;
  - Ctrl+Shift+E itself rewrites.

Needs Playwright and a local Chrome:
    pip install playwright
    python3 scripts/check_windows.py
"""
import functools
import http.server
import sys
import threading
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

ROOT = Path(__file__).resolve().parents[1]
WINDOWS_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_port}/extension/tests/pill-harness.html"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1366, "height": 768}, user_agent=WINDOWS_UA)
        ctx.add_init_script("Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        ev = page.evaluate

        def load(shortcut="Ctrl+Shift+E", fresh=True):
            page.goto(url)
            if fresh:
                ev("localStorage.clear(); sessionStorage.clear()")
            ev(f"window.FAKE_SHORTCUT = {shortcut!r}")
            page.goto(url)
            ev(f"window.FAKE_SHORTCUT = {shortcut!r}")
            page.wait_for_function("document.getElementById('pm-trigger')")

        def tip_text():
            page.wait_for_selector("#pm-tip", timeout=6000)
            return page.inner_text("#pm-tip")

        # The page believes it is on Windows.
        load()
        check(ev("navigator.platform") == "Win32" and ev("IS_MAC") is False, "content.js sees Windows")
        check(ev("CMD_KEY") == "Ctrl+", "and names the modifier Ctrl+")

        # ── The first tip names the assigned shortcut ──
        text = tip_text()
        check("Ctrl+Shift+E" in text and "⌘" not in text and "⇧" not in text,
              f"the tip names Ctrl+Shift+E, with no Mac symbols: {text!r}")

        # ── Chrome left the shortcut unassigned ──
        load(shortcut="")
        text = tip_text()
        check("Ctrl+Shift+E" not in text, "no shortcut is promised when Chrome did not assign one")
        check("not set yet" in text, f"it says the shortcut is not set: {text!r}")
        buttons = [b.strip() for b in page.locator("#pm-tip .pm-tip-btn").all_inner_texts()]
        check("Set a shortcut" in buttons, f"and offers to set one, got {buttons}")

        # ── A shortcut the user chose themselves is named as it is ──
        load(shortcut="Alt+Shift+P")
        check("Alt+Shift+P" in tip_text(), "a custom shortcut is named as Chrome reports it")

        # ── Ctrl+Shift+E rewrites, and the card speaks Windows ──
        load()
        ev("FAKE.calls = []; H.type(H.ORIG)")
        page.focus("#composer")
        page.keyboard.press("Control+Shift+E")
        page.wait_for_function("(document.querySelector('#pm-card .pm-card-title')?.textContent || '').includes('Rewrite')", timeout=6000)
        check(ev("FAKE.calls") == ["deep"], "Ctrl+Shift+E rewrites on Windows")
        foot = page.inner_text("#pm-card .pm-card-foot")
        check("Ctrl+S" in foot and "⌘" not in foot, f"the card's keys read Ctrl+: {foot!r}")
        tip = page.inner_text("#pm-card-tip") if page.locator("#pm-card-tip").count() else ""
        check("⌘" not in tip, "the card's tip has no Mac symbols")
        page.click("#pm-card-accept")
        text = tip_text()
        check("⌘" not in text, f"the after-Replace tip has no Mac symbols: {text!r}")

        # ── The library's key hints ──
        ev("H.signIn()")
        load(fresh=False)
        page.focus("#composer")
        page.keyboard.press("Control+Shift+L")
        page.wait_for_selector("#pm-library:not([hidden])", timeout=6000)
        page.wait_for_function("!document.querySelector('#pm-library .pm-lib-skeleton')")
        hints = page.inner_text("#pm-library .pm-lib-foot")
        check("⌘" not in hints and ("Ctrl" in hints or "//" in hints), f"library hints read Ctrl+: {hints!r}")

        check(not errors, f"page errors: {errors}")
        browser.close()
    httpd.shutdown()
    print(f"{checks} Windows checks PASS")


if __name__ == "__main__":
    main()
