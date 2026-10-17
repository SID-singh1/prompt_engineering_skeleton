"""Capture the storyboard frames for the product video (1280x800 PNGs).

Runs the real content.js on the pill harness with the server faked.
    python scripts/serve_harness.py 8765     # in another terminal
    python docs/store/video/capture_frames.py [harness-url]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/tests/pill-harness.html"
OUT = Path(__file__).resolve().parent
TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"
DRAFT = "hw do i sort a list of dicts by a key in python, some dont have the key"
CHAT = (
    '<p><b data-message-author-role="user">i have a list of user records from an api, each is a dict</b></p>'
    "<p>Got it. Each record is a Python dictionary, so you can filter, group or sort them with plain list operations. "
    "What would you like to do with them?</p>"
    '<p><b data-message-author-role="user">first i want them in order of signup date</b></p>'
    "<p>Use sorted() with a key function that reads the signup date. Records missing the field need a rule: "
    "put them first, put them last, or leave them out.</p>"
)
CONTEXT = {
    "selected_prompts": [],
    "auto_matched_prompts": [
        {"id": "p1", "title": "Code review template", "content": "Review this diff like a senior engineer: correctness first.", "score": 0.62},
        {"id": "p4", "title": "Bug report triage", "content": "List the likely root causes ranked by probability.", "score": 0.41},
    ],
    "passive_patterns": [{"original": "sort dicts python", "refined": "Show me how to sort a list of dicts by key in Python.", "score": 0.33}],
}


def fresh(pg):
    pg.goto(URL)
    pg.evaluate("sessionStorage.clear()")   # no draft carried over from the scene before
    pg.evaluate("localStorage.setItem('pm', JSON.stringify(%s))" % json.dumps({
        "pm_data_consent_v1": True, "token": TOKEN, "user_id": "u1", "email": "u@example.com",
        "pm_tips": {"meet": 1, "card": 1, "save": 1, "slash": 1}, "pm_stats": {"rewrites": 3}}))
    pg.reload()
    pg.wait_for_selector("#pm-trigger")
    pg.wait_for_timeout(900)
    pg.evaluate("closeCard(); document.getElementById('ctl')?.remove(); document.getElementById('pm-tip')?.remove()")
    pg.evaluate("(html) => { document.querySelector('[data-message-author-role=\"user\"]').closest('p').parentElement.innerHTML = html; }", CHAT)


def card(pg):
    pg.evaluate("""(ctx) => {
      H.type(%s); H.stream();
      finalizeStreamingModal({ enhanced: H.DRAFT, original: %s, log_id: "log_1", mode: "deep", latency: 1.1,
        context_used: { selected: 0, auto_matched: 2 }, context_details: ctx });
    }""" % (json.dumps(DRAFT), json.dumps(DRAFT)), CONTEXT)
    pg.wait_for_timeout(600)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)

    # 1. The rough draft, the ⊕ waiting in the corner.
    fresh(pg)
    pg.click("#composer")
    pg.keyboard.type(DRAFT)
    pg.mouse.move(1247, 760)
    pg.wait_for_timeout(500)
    pg.screenshot(path=str(OUT / "frame-1-rough-draft.png"))

    # 2. The rewrite on the card, Replace draft and the other styles.
    card(pg)
    pg.mouse.move(5, 5)
    pg.screenshot(path=str(OUT / "frame-2-rewrite-card.png"))

    # 3. The context it used, two left out, Retry offered.
    pg.click("#pm-card-used-toggle")
    pg.click("#pm-card-used-list [data-pm-drop='p4']")
    pg.click("#pm-card-used-list [data-pm-drop='p:0']")
    pg.wait_for_timeout(400)
    pg.mouse.move(5, 5)
    pg.screenshot(path=str(OUT / "frame-3-context-retry.png"))

    # 4. Select part of an answer: Save as context.
    fresh(pg)
    para = pg.locator("xpath=(//p[b[@data-message-author-role='user']])[2]/following-sibling::p[1]")
    box = para.bounding_box()
    pg.mouse.move(box["x"] + 2, box["y"] + 4)
    pg.mouse.down()
    pg.mouse.move(box["x"] + box["width"] - 6, box["y"] + box["height"] - 4, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / "frame-4-save-selection.png"))

    # 5. Type // and a saved prompt drops in where you are typing.
    fresh(pg)
    pg.click("#composer")
    pg.keyboard.type("Before I merge, can you ")
    pg.keyboard.type("//rev", delay=60)
    pg.wait_for_selector("#pm-caret .pm-caret-row", timeout=5000)
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "frame-5-slash-insert.png"))
    b.close()
print(sorted(x.name for x in OUT.glob("frame-*.png")))
