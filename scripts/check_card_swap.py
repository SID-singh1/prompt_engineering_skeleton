"""The rewrite goes into the chat box; the card shows the original; retrieved
context is unticked and retried by hand, with no new search.

Drives the pill harness (real content.js, chrome.* and the server faked):

    python scripts/serve_harness.py            # port 8765
    python scripts/check_card_swap.py          # PM_HARNESS_URL to point elsewhere
    PM_SHOTS=some/dir python scripts/check_card_swap.py   # also save screenshots
"""
import json
import os
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

BASE = os.environ.get("PM_HARNESS_URL", "http://localhost:8765/tests/pill-harness.html") + "?backend=1"
CHANNEL = os.environ.get("PM_BROWSER_CHANNEL", "chrome")
SHOTS = os.environ.get("PM_SHOTS")
TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"
DRAFT = "hw do i sort a list of dicts by a key in python, some dont have the key"
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(channel=CHANNEL, headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE)
        pg.evaluate("localStorage.setItem('pm', JSON.stringify(%s))" % json.dumps({
            "pm_data_consent_v1": True, "pm_fill_box": True, "token": TOKEN, "user_id": "u1", "email": "u@example.com",
            "pm_tips": {"meet": 1, "card": 1, "save": 1, "slash": 1}, "pm_stats": {"rewrites": 3}}))
        pg.reload()
        pg.wait_for_selector("#pm-trigger", timeout=8000)
        pg.wait_for_timeout(900)
        box = lambda: pg.evaluate("document.getElementById('composer').innerText.trim()")
        shot = lambda name: SHOTS and pg.screenshot(path=os.path.join(SHOTS, name + ".png"))
        quick, deep = pg.evaluate("FAKE.text.quick"), pg.evaluate("FAKE.text.deep")

        # ── The rewrite lands in the box; the card shows what was typed ──
        pg.click("#composer")
        pg.keyboard.type(DRAFT)
        pg.click("#pm-trigger")
        pg.wait_for_selector("#pm-card.pm-card-inbox", timeout=8000)
        pg.wait_for_timeout(300)
        check(box() == deep, f"the finished rewrite is in the chat box, got {box()!r}")
        card = pg.inner_text("#pm-card")
        check("You wrote" in card and DRAFT in card, "the card shows what was typed")
        check("rewrite in your chat box" in card.lower(), "and says where the rewrite is")
        foot = [t.strip() for t in pg.locator("#pm-card .pm-card-foot .pm-card-btn").all_inner_texts()]
        check(foot[:2] == ["Keep", "Put mine back"], f"Keep and Put mine back lead, got {foot}")
        check(pg.locator("#pm-card [data-pm-style]").count() == 2, "the other two styles are still there")
        shot("1_inbox")

        # ── The toggle swaps the card's text, not the box ───────────────
        pg.click("#pm-card-toggle")
        pg.wait_for_timeout(200)
        check(deep in pg.inner_text("#pm-card .pm-card-text") and box() == deep, "the toggle shows the rewrite on the card; the box is untouched")
        pg.click("#pm-card-toggle")

        # ── Retrieved context: untick two, nothing runs; Retry; no search ─
        searches = pg.evaluate("FAKE_API.searches")
        calls = pg.evaluate("FAKE.calls.length")
        pg.click("#pm-card-used-toggle")
        items = pg.locator("#pm-card-used-list .pm-card-used-item")
        check(items.count() == 3, f"two matched saved prompts and one past pattern are listed, got {items.count()}")
        check("found by Prompt Memory" in pg.inner_text("#pm-card-used-list") and "from a past prompt" in pg.inner_text("#pm-card-used-list"),
              "each says it was found by the engine")
        pg.click("#pm-card-used-list [data-pm-drop='p4']")
        pg.click("#pm-card-used-list [data-pm-drop='p:0']")
        pg.wait_for_timeout(400)
        check(pg.evaluate("FAKE.calls.length") == calls, "unticking starts nothing")
        check(pg.locator("#pm-card-used-list .pm-card-used-off").count() == 2, "the two are marked as left out")
        check("Retry without them" in pg.inner_text("#pm-card-used-list") and "Nothing is searched again" in pg.inner_text("#pm-card-used-list"),
              "and Retry is offered")
        shot("2_untick")
        pg.click("#pm-card-used-list [data-pm-drop='p:0']")   # tick one back
        pg.wait_for_timeout(200)
        check("Retry without it" in pg.inner_text("#pm-card-used-list"), "ticking one back counts down")
        pg.click("#pm-card-retry")
        pg.wait_for_function("(document.getElementById('composer').innerText || '').includes('less context')", timeout=8000)
        pg.wait_for_timeout(300)
        sent = pg.evaluate("FAKE_API.calls.filter(c => c.path === '/enhance/stream').pop().body")
        check(sent.get("reuse_context") == {"matched": [{"id": "p1", "score": 0.62}],
                                           "passive": [{"original": "sort dicts python", "refined": "Show me how to sort a list of dicts by key in Python.", "score": 0.33}]},
              f"Retry sends exactly the kept context, got {sent.get('reuse_context')}")
        check(pg.evaluate("FAKE_API.searches") == searches, "and the server searched nothing")
        check("p4" in sent.get("excluded_prompt_ids", []), "the dropped one is excluded too")
        check("Left out: Bug report triage" in pg.inner_text("#pm-card"), "the card names what was left out")
        check("2 of 2" in pg.inner_text("#pm-card .pm-card-head"), "the retry is a new version; the first is kept")

        # ── A style rerun reuses the context too, and fills the box ─────
        pg.click("#pm-card [data-pm-style='quick']")
        pg.wait_for_function(f"document.getElementById('composer').innerText.trim().startsWith({json.dumps(quick)})", timeout=8000)
        check(pg.evaluate("FAKE_API.searches") == searches, "Shorter goes straight to the model too")
        pg.click("#pm-card-ver-prev")
        pg.wait_for_timeout(500)
        check("less context" in box() and box().startswith(deep), f"stepping back puts that version in the box, got {box()!r}")

        # ── Put mine back, then Keep ────────────────────────────────────
        pg.click("#pm-card-mine")
        pg.wait_for_timeout(500)
        check(box() == DRAFT, f"Put mine back restores exactly what was typed, got {box()!r}")
        check(pg.locator("#pm-card.pm-card-inbox").count() == 0 and pg.locator("#pm-card-accept").count() == 1,
              "and the card goes back to offering Replace")
        pg.click("#pm-card-accept")
        pg.wait_for_timeout(500)
        check(box().startswith(deep), "Replace still works")

        # ── Editing the rewrite in the box keeps it ─────────────────────
        pg.evaluate("document.getElementById('composer').focus(); document.execCommand('selectAll'); document.execCommand('delete')")
        pg.keyboard.type(DRAFT)
        pg.evaluate("clearApplied()")   # the "Inserted" receipt: a click on it only dismisses it
        pg.click("#pm-trigger")
        pg.wait_for_selector("#pm-card.pm-card-inbox", timeout=8000)
        pg.wait_for_timeout(300)
        pg.click("#composer")
        pg.keyboard.press("End")
        pg.keyboard.type(" Thanks!")
        pg.wait_for_timeout(500)
        check(pg.locator("#pm-card.pm-card-visible").count() == 0, "editing the rewrite in the box closes the card: it is kept")
        check(box().endswith("Thanks!"), "and the edit stands")
        check(not errors, f"page errors: {errors}")
        b.close()
    print(f"{checks} card swap checks PASS")


if __name__ == "__main__":
    main()
