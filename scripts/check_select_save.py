"""Select text on the page, save it as context: drives the pill harness.

    python scripts/serve_harness.py         # or any server for extension/, port 8765
    python scripts/check_select_save.py     # PM_HARNESS_URL to point elsewhere
"""
import json
import os
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

BASE = os.environ.get("PM_HARNESS_URL", "http://localhost:8765/tests/pill-harness.html")
CHANNEL = os.environ.get("PM_BROWSER_CHANNEL", "chrome")
SHOT = os.environ.get("PM_SHOT")
TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def open_page(b, signed_in):
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(BASE)
    store = {"pm_data_consent_v1": True, "pm_tips": {"meet": 1, "card": 1, "save": 1, "slash": 1}}
    if signed_in:
        store.update(token=TOKEN, user_id="u1", email="u@example.com")
    pg.evaluate(f"localStorage.setItem('pm', JSON.stringify({json.dumps(store)}))")
    pg.reload()
    pg.wait_for_selector("#pm-trigger")
    pg.wait_for_timeout(900)
    return pg


def select_answer(pg):
    """Drag across the second message, as a person would select it."""
    # The first answer: the paragraph after the first user message.
    p = pg.locator("xpath=(//p[b[@data-message-author-role='user']])[1]/following-sibling::p[1]")
    box = p.bounding_box()
    pg.mouse.move(box["x"] + 2, box["y"] + 4)
    pg.mouse.down()
    pg.mouse.move(box["x"] + box["width"] - 4, box["y"] + box["height"] - 4, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    return pg.evaluate("window.getSelection().toString().trim()")


def visible(pg):
    return pg.evaluate("(() => { const b = document.getElementById('pm-select-save'); return Boolean(b && !b.hidden); })()")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(channel=CHANNEL, headless=True)

        # ── Signed in: select, save, it is in Saved ─────────────────────
        pg = open_page(b, True)
        text = select_answer(pg)
        check(len(text) > 12, f"the drag selected an answer, got {text!r}")
        check(visible(pg), "a Save as context button appears beside the selection")
        r = pg.locator("#pm-select-save").bounding_box()
        check(0 <= r["x"] and r["x"] + r["width"] <= 1280 and 0 <= r["y"] <= 800, "on screen")
        if SHOT:
            pg.screenshot(path=SHOT)
        n = pg.evaluate("FAKE_API.prompts.length")
        pg.click("#pm-select-save")
        pg.wait_for_timeout(600)
        posted = pg.evaluate("FAKE_API.calls.filter(c => c.path === '/saved-prompts' && c.method === 'POST').pop()")
        check(posted and posted["body"]["content"] == text, f"pressing it saves exactly the selected text, got {posted}")
        check(pg.evaluate("FAKE_API.prompts.length") == n + 1, "it is in the library")
        check("Saved to your library" in pg.inner_text("#pm-toast-stack"), "and the toast says where to find it")
        check(not visible(pg), "the button goes away")
        pg.evaluate("togglePanel(true)")
        pg.wait_for_timeout(500)
        check(text[:30] in pg.inner_text("#pm-library"), "it shows in the library's Saved list")
        pg.evaluate("closeLibrary()")

        # ── Not offered where it would get in the way ───────────────────
        pg.click("#composer")
        pg.keyboard.type("my own draft that I am editing right now")
        pg.keyboard.press("ControlOrMeta+a")
        pg.keyboard.up("Shift")
        pg.evaluate("document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))")
        pg.wait_for_timeout(200)
        check(not visible(pg), "not for text selected in the chat box")
        pg.mouse.click(5, 790)
        pg.evaluate("window.getSelection().removeAllRanges()")
        select_answer(pg)
        check(visible(pg), "shown again for page text")
        # The harness page is too short to scroll; the event is what the page sees.
        pg.evaluate("document.dispatchEvent(new Event('scroll'))")
        pg.wait_for_timeout(200)
        check(not visible(pg), "scrolling puts it away")

        # ── The switch in Privacy settings turns it off ─────────────────
        pg.evaluate("togglePanel(true); libPage = 'privacy'; renderLibrary()")
        pg.wait_for_timeout(300)
        pg.uncheck("#pm-select-save-toggle")
        pg.evaluate("closeLibrary()")
        select_answer(pg)
        check(not visible(pg), "switched off, it is not offered")
        check(not pg.errors, f"page errors: {pg.errors}")
        pg.close()

        # ── Signed out: offered, and pressing it asks to sign in ─────────
        pg = open_page(b, False)
        select_answer(pg)
        check(visible(pg), "signed out it is still offered")
        calls = pg.evaluate("FAKE_API.calls.length")
        pg.click("#pm-select-save")
        pg.wait_for_timeout(400)
        check("Sign in" in pg.inner_text("#pm-toast-stack"), "and pressing it asks to sign in")
        check(pg.evaluate("FAKE_API.calls.filter(c => c.path === '/saved-prompts' && c.method === 'POST').length") == 0,
              "without sending anything")
        check(not pg.errors, f"page errors: {pg.errors}")
        b.close()
    print(f"{checks} save-selection checks PASS")


if __name__ == "__main__":
    main()
