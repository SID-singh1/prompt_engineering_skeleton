"""The "end" frames that go with capture_frames.py's start frames, so each
10-second clip can start on one screenshot and finish on another.

  frame-2b-replaced.png   after Replace draft: the rewrite is in the chat box
  frame-3b-retried.png    after Retry without them: version 2 of 2, less context

Runs the real content.js on the pill harness. The retry frame is composed
with the calls a retry makes when its stream finishes.

    python docs/store/video/capture_end_frames.py [harness-url]
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/tests/pill-harness.html"
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


def fresh(pg, url):
    pg.goto(url)
    pg.evaluate("sessionStorage.clear()")
    pg.evaluate("localStorage.setItem('pm', JSON.stringify(%s))" % json.dumps({
        "pm_data_consent_v1": True, "pm_fill_box": False, "token": TOKEN, "user_id": "u1", "email": "u@example.com",
        "pm_tips": {"meet": 1, "card": 1, "save": 1, "slash": 1}, "pm_stats": {"rewrites": 3}}))
    pg.reload()
    pg.wait_for_selector("#pm-trigger")
    pg.wait_for_timeout(900)
    pg.evaluate("closeCard(); document.getElementById('ctl')?.remove(); document.getElementById('pm-tip')?.remove()")
    pg.evaluate("(html) => { document.querySelector('[data-message-author-role=\"user\"]').closest('p').parentElement.innerHTML = html; }", CHAT)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)

    # 2b. Replace draft: the rewrite is in the chat box, the card is gone.
    fresh(pg, BASE)
    pg.evaluate("(d) => { H.type(d); H.stream(); H.done(); }", DRAFT)
    pg.wait_for_selector("#pm-card-accept", timeout=5000)
    pg.click("#pm-card-accept")
    pg.wait_for_timeout(900)
    pg.mouse.move(5, 5)
    pg.screenshot(path=str(OUT / "frame-2b-replaced.png"))

    # 3b. After Retry without two left-out items: version 2 of 2. Built with
    # the same calls a retry makes when its stream finishes (a second version
    # whose context is only what was kept, and "Left out" naming the rest).
    fresh(pg, BASE)
    pg.evaluate("""(d) => {
      H.type(d); H.stream();
      const kept = { id: "p1", title: "Code review template", content: "Review this diff like a senior engineer: correctness first.", score: 0.62 };
      const all = { selected_prompts: [], passive_patterns: [{ original: "sort dicts python", refined: "Show me how to sort a list of dicts by key in Python.", score: 0.33 }],
                    auto_matched_prompts: [kept, { id: "p4", title: "Bug report triage", content: "List the likely root causes ranked by probability.", score: 0.41 }] };
      finalizeStreamingModal({ enhanced: H.DRAFT, original: d, log_id: "log_1", mode: "deep", context_details: all, context_used: { selected: 0, auto_matched: 2 } });
      cardRerunFrom = { versions: cardVersions.slice(), index: cardVersionIndex };
      showStreamingDiffModal(d, "deep");
      finalizeStreamingModal({ enhanced: H.DRAFT.replace("Provide a robust solution that avoids KeyError, explain the choice", "Explain the choice"), original: d, log_id: "log_2", mode: "deep",
        excluded: [{ id: "p4", title: "Bug report triage" }, { title: "Past prompt: sort dicts python" }],
        context_details: { selected_prompts: [], passive_patterns: [], auto_matched_prompts: [kept] }, context_used: { selected: 0, auto_matched: 1 } });
    }""", DRAFT)
    pg.wait_for_timeout(700)
    pg.click("#pm-card-used-toggle")
    pg.wait_for_timeout(300)
    pg.mouse.move(5, 5)
    pg.screenshot(path=str(OUT / "frame-3b-retried.png"))
    b.close()
print("ok")
