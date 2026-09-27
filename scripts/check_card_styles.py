"""Drive the real content.js through the card's style and version flow in Chrome.

Uses extension/tests/pill-harness.html, whose chrome.* shim routes every
enhancement to a fake direct-path stream (window.FAKE), so no network or API
key is involved. Checks what the user would see and what gets requested:
titles, button labels, how many model calls were made, what lands in the chat
box, what survives a reload, and that cancelling or failing a rerun never
costs the draft.

Needs Playwright and a local Chrome:
    pip install playwright   # the browser itself is the installed Chrome
    python3 scripts/check_card_styles.py [--shots DIR]
"""
import argparse
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
    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="directory for screenshots of the card")
    args = ap.parse_args()
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_port}/extension/tests/pill-harness.html"

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        ev = page.evaluate

        def load():
            page.goto(url)
            page.wait_for_function("document.getElementById('pm-trigger')")
            page.wait_for_timeout(300)

        def title():
            return page.inner_text("#pm-card .pm-card-title").strip().lower()

        def wait_title(text):
            page.wait_for_function(
                "t => (document.querySelector('#pm-card .pm-card-title')?.textContent || '').toLowerCase().trim() === t",
                arg=text.lower(), timeout=5000)

        def styles():
            return [b.strip() for b in page.locator("#pm-card .pm-card-style").all_inner_texts()]

        def shot(name):
            if args.shots:
                Path(args.shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(args.shots) / f"{name}.png"))

        load()
        ev("localStorage.clear(); sessionStorage.clear()")
        load()
        check(ev("currentMode") == "deep", "fresh install defaults to Deep")

        # ── a first rewrite, in the default style ──
        ev("H.type(H.ORIG)")
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        check(styles() == ["Shorter", "Open-ended"], f"Deep offers Shorter and Open-ended, got {styles()}")
        check(page.locator("#pm-card .pm-card-versions").count() == 0, "one version: no stepper")
        check(ev("FAKE.calls") == ["deep"], "one call so far")
        shot("1-deep")

        # ── Shorter: a second version, the default untouched ──
        page.click("#pm-card-style-quick")
        page.wait_for_function("(document.querySelector('#pm-card .pm-card-title')?.textContent || '').includes('Quick')")
        check("rewriting" in title() or title() == "rewrite · quick", "rerun names its style while streaming")
        wait_title("Rewrite · Quick")
        check(ev("FAKE.calls") == ["deep", "quick"], "Shorter asked for Quick")
        check(ev("currentMode") == "deep", "a rerun does not change the default")
        check(ev("cardVersions.length") == 2 and ev("cardVersionIndex") == 1, "the Quick version is added, and shown")
        check(page.inner_text("#pm-card .pm-card-text").strip() == ev("FAKE.text.quick"), "card shows the Quick text")
        check(styles() == ["More detail", "Open-ended"], f"Quick offers More detail and Open-ended, got {styles()}")
        check("pm-card-style-made" in page.get_attribute("#pm-card-style-deep", "class"), "Deep is marked as already made")
        check(page.inner_text("#pm-card .pm-card-versions").replace("\n", " ").strip().startswith("‹"), "stepper shown")
        check("2 of 2" in page.inner_text("#pm-card .pm-card-versions"), "stepper reads 2 of 2")
        check(ev("draftStore.load().then(d => d.versions.length)") == 2, "versions are written to the draft")
        shot("2-quick-two-versions")

        # ── going back is free ──
        page.click("#pm-card-style-deep")
        wait_title("Rewrite · Deep")
        check(ev("FAKE.calls.length") == 2, "switching to a made style makes no call")
        page.focus("#pm-card-min")
        page.keyboard.press("]")
        wait_title("Rewrite · Quick")
        page.keyboard.press("[")
        wait_title("Rewrite · Deep")
        check(ev("FAKE.calls.length") == 2, "[ and ] make no calls")

        # ── cancelling a rerun keeps the draft ──
        ev("FAKE.delay = 300")
        page.click("#pm-card-style-creative")
        page.wait_for_function("cardState === 'streaming'")
        page.focus("#pm-card-min")
        page.keyboard.press("Escape")
        wait_title("Rewrite · Deep")
        check(ev("cardState") == "ready" and ev("cardVersions.length") == 2 and ev("cardVersionIndex") == 0,
              "Esc during a rerun returns to the version it started from")
        page.wait_for_timeout(700)
        check(ev("cardVersions.length") == 2 and ev("cardState") == "ready", "the cancelled stream never lands")

        # the pill's × does the same
        page.click("#pm-card-style-creative")
        page.wait_for_function("cardState === 'streaming'")
        page.click("#pm-trigger .pm-pill-x")
        page.wait_for_function("cardState === 'ready'")
        check(ev("cardVersions.length") == 2, "the pill's × during a rerun keeps the draft")

        # ── a failing rerun keeps the draft and says why ──
        ev("FAKE.delay = 25; FAKE.failNext = true")
        page.click("#pm-card-style-creative")
        page.wait_for_function("cardState === 'ready' && !cardRerunFrom")
        page.wait_for_timeout(100)
        toast = " ".join(page.locator(".pm-toast").all_inner_texts())
        check("Creative version" in toast and "Rate limited" in toast, f"failure is explained, got {toast!r}")
        check(ev("cardVersions.length") == 2, "a failed rerun keeps both versions")

        # ── a third style ──
        page.click("#pm-card-style-creative")
        wait_title("Rewrite · Creative")
        check(ev("cardVersions.length") == 3, "three versions")
        check(styles() == ["Shorter", "More focused"], f"Creative offers Shorter and More focused, got {styles()}")
        check(page.locator("#pm-card .pm-card-style-made").count() == 2, "both others already made")

        # ── a reload brings the versions back ──
        load()
        page.wait_for_function("cardState === 'ready'")
        check(ev("cardVersions.length") == 3 and ev("cardVersionIndex") == 2, "versions and position survive a reload")
        wait_title("Rewrite · Creative")
        check("3 of 3" in page.inner_text("#pm-card .pm-card-versions"), "stepper restored")

        # ── inserting uses the version on screen ──
        page.click("#pm-card-style-quick")
        wait_title("Rewrite · Quick")
        page.click("#pm-card-accept")
        page.wait_for_timeout(300)
        check(ev("document.getElementById('composer').textContent.trim()") == ev("FAKE.text.quick"),
              "Insert writes the version being shown")
        check(ev("cardState") == "idle" and ev("cardVersions.length") == 0, "inserting clears the versions")

        # ── the default style is remembered ──
        ev("setDefaultStyle('quick')")
        load()
        check(ev("cardState") == "idle", "an inserted draft does not come back on reload")
        check(ev("currentMode") == "quick", "the default survives a reload")
        ev("FAKE.calls = []; H.type(H.ORIG)")
        page.click("#pm-trigger")
        wait_title("Rewrite · Quick")
        check(ev("FAKE.calls") == ["quick"], f"⊕ runs the saved default, calls were {ev('FAKE.calls')}")

        # ── stale: Redo is the only action, the row goes ──
        ev("H.type('something else entirely')")
        page.wait_for_function("cardStale === true")
        check(page.locator("#pm-card .pm-card-styles").count() == 0, "no style row on a stale draft")
        ev("H.type(H.ORIG)")
        page.wait_for_function("cardStale === false")
        check(page.locator("#pm-card .pm-card-styles").count() == 1, "the row comes back when fresh again")

        # ── the original is showing: nothing to vary ──
        page.click("#pm-card-toggle")
        check(page.locator("#pm-card .pm-card-styles").count() == 0, "no style row while the original shows")
        page.click("#pm-card-toggle")

        # ── the daily allowance (server route only) ──
        ev("cardResult.direct = false; usageData = { count: 13, limit: 15 }; showDiffModal(cardResult)")
        check(styles() == ["More detail · 2 left", "Open-ended · 2 left"], f"low allowance is shown, got {styles()}")
        ev("usageData = { count: 15, limit: 15 }; showDiffModal(cardResult)")
        check(page.get_attribute("#pm-card-style-deep", "aria-disabled") == "true", "no allowance left: disabled")
        n = ev("FAKE.calls.length")
        # aria-disabled, not disabled: still clickable, so it can say why.
        page.click("#pm-card-style-deep", force=True)
        page.wait_for_timeout(150)
        check(ev("FAKE.calls.length") == n and ev("cardVersions.length") == 1, "a spent allowance makes no call")
        check("No rewrites left" in " ".join(page.locator(".pm-toast").all_inner_texts()), "and says so")
        ev("usageData = { count: 0, limit: 15 }; cardResult.direct = true; showDiffModal(cardResult)")

        # ── a voice draft: its baseline is the chat box, not the transcript ──
        ev("closeCard(); FAKE.calls = []; H.type('half written message')")
        ev("""showStreamingDiffModal('spoken transcript here'); cardBasedOn = norm('half written message');
              cardHasBaseline = true; finalizeStreamingModal({ enhanced: 'Voice rewrite', original: 'spoken transcript here',
              mode: 'deep', direct: true })""")
        wait_title("Rewrite · Deep")
        check(not ev("cardStale"), "a voice draft over a half-written message starts fresh")
        page.click("#pm-card-style-quick")
        wait_title("Rewrite · Quick")
        check(not ev("cardStale") and page.locator("#pm-card-accept").count() == 1,
              "trying a style on a voice draft keeps it insertable")
        check(ev("cardBasedOn") == "half written message", "the voice draft's baseline survives the rerun")
        ev("closeCard()")

        # ── a draft saved before versions existed ──
        ev("""draftStore.save({ result: { enhanced: 'Old draft text', original: 'old', mode: 'deep' },
                basedOn: 'old', createdAt: Date.now(), source: 'x', expanded: true })""")
        load()
        page.wait_for_function("cardState === 'ready'")
        check(ev("cardVersions.length") == 1 and ev("cardResult.enhanced") == "Old draft text", "old drafts still load")
        ev("closeCard(); setDefaultStyle('deep')")

        # ── the shortcut shows a draft and never hides it ──
        # Testers pressed Ctrl+Shift+E twice: the first press rewrote, the second
        # hid the card, and the shortcut read as broken.
        def shortcut():
            page.focus("#composer")
            page.keyboard.press("Control+Shift+E")
            page.wait_for_timeout(250)

        def card_open():
            return ev("Boolean(document.querySelector('#pm-card.pm-card-visible')) && cardExpanded")

        ev("FAKE.calls = []; H.type(H.ORIG)")
        shortcut()
        wait_title("Rewrite · Deep")
        check(ev("FAKE.calls") == ["deep"], "the shortcut rewrites a new draft")
        for n in (2, 3):
            shortcut()
            check(card_open(), f"press {n} on the same draft keeps the card open")
        check(ev("FAKE.calls") == ["deep"], "pressing again on the same draft makes no call")
        check("Already rewritten" in " ".join(page.locator(".pm-toast").all_inner_texts()), "and says why nothing new came")
        page.focus("#pm-card-min")
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        check(not card_open() and ev("cardState") == "ready", "Esc tucks the draft into the pill")
        shortcut()
        check(card_open() and ev("FAKE.calls") == ["deep"], "the shortcut brings a tucked-away draft back, for free")
        ev("H.type('a completely different question about rust lifetimes')")
        shortcut()
        page.wait_for_function("FAKE.calls.length === 2")
        wait_title("Rewrite · Deep")
        check(ev("cardOriginal") == "a completely different question about rust lifetimes", "new text: the shortcut rewrites it")
        page.click("#pm-trigger", position={"x": 12, "y": 12})
        page.wait_for_timeout(250)
        check(not card_open(), "a click on the pill still folds the card (the pill is its handle)")
        ev("closeCard()")

        # ── screenshots, dark and light host ──
        if args.shots:
            ev("FAKE.calls = []; H.type(H.ORIG)")
            page.click("#pm-trigger")
            wait_title("Rewrite · Deep")
            page.click("#pm-card-style-quick")
            wait_title("Rewrite · Quick")
            shot("3-dark")
            page.click("text=light")
            page.wait_for_timeout(200)
            shot("4-light")
            ev("closeCard()")

        check(not errors, f"page errors: {errors}")
        browser.close()
    httpd.shutdown()
    print(f"{checks} card style checks PASS")


if __name__ == "__main__":
    main()
