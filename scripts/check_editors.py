"""Check // and the rewrite card inside the real editors the chat sites use.

Uses extension/tests/editors-harness.html, which mounts ProseMirror (ChatGPT,
Claude), Quill (Gemini), Lexical or a textarea and runs the real content.js
over it. ProseMirror sends no input events while typing, which is how // came
to do nothing on ChatGPT and Claude while every plain-contenteditable test
passed; every check here is made against the editor's own text, not the DOM,
and every editor's Enter "sends" (window.SENT), so a // pick that leaked
through to the host would show.

Needs Playwright, a local Chrome and the network (the editors load from
esm.sh and jsdelivr):
    python3 scripts/check_editors.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_card_styles import serve  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

EDITORS = ["prosemirror", "quill", "lexical", "textarea"]
TEMPLATE = ("Review this diff like a senior engineer: correctness first, then naming, then tests. "
            "Flag anything that changes behaviour.")
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def run(browser, base, kind):
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    ready = "window.EDITOR_READY && document.getElementById('pm-trigger') && document.getElementById('pm-library')"
    try:
        page.goto(f"{base}?editor={kind}")
        page.wait_for_function(ready, timeout=30000)
    except Exception:
        page.close()
        raise SystemExit(f"{kind}: the editor did not load. The harness needs the network (esm.sh, jsdelivr).")
    page.evaluate("localStorage.clear(); sessionStorage.clear(); E.signIn()")
    page.reload()
    page.wait_for_function(ready, timeout=30000)
    page.wait_for_timeout(600)
    ev = page.evaluate
    box = "#mount .ProseMirror, #mount .ql-editor, #mount[contenteditable], textarea"

    def text():
        return ev("EDITOR.text()").replace(" ", " ")

    def clear():
        # Through the editor's own API. ⌘A then Backspace leaves headless
        # ProseMirror unable to take the next Backspace, with or without the
        # extension loaded, which is a harness artefact and not what is tested.
        ev("EDITOR.clear()")
        page.click(box)
        page.wait_for_timeout(80)

    def type_(s, delay=25):
        page.keyboard.type(s, delay=delay)
        page.wait_for_timeout(150)

    def menu_rows():
        return page.locator("#pm-caret .pm-caret-row").count()

    def sent():
        return ev("SENT")

    # ── the site focused the box itself: no click before typing ──
    # ChatGPT and Claude focus the chat box on load and on a new chat, and
    # people just start typing. Focused that way, ProseMirror inserts each
    # character itself and fires no input event; after a click it does. This
    # is the case the old input-event listener missed.
    ev("EDITOR.clear(); EDITOR.el.focus()")
    page.wait_for_timeout(80)
    type_("//rev")
    check(menu_rows() == 1, f"{kind}: // opens when the site focused the box and nobody clicked")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(text() == TEMPLATE and sent() == 0, f"{kind}: and ↵ inserts without sending, got {text()!r}")

    # ── // opens, filters, and ↵ inserts where it was ──
    clear()
    type_("Before I merge, can you //rev")
    check(menu_rows() == 1, f"{kind}: //rev opens the menu with one match")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(text() == "Before I merge, can you " + TEMPLATE,
          f"{kind}: ↵ inserts the prompt where // was, in the editor's own text, got {text()!r}")
    check(sent() == 0, f"{kind}: the Enter that picked the prompt did not send")
    check(page.locator("#pm-caret").count() == 0, f"{kind}: and the menu closed")
    page.keyboard.press("Enter")
    check(sent() == 1, f"{kind}: a later Enter still sends")

    # ── ⇥ attaches and drops the //query ──
    clear()
    type_("look at //bug")
    page.keyboard.press("Tab")
    page.wait_for_timeout(300)
    check("//bug" not in text() and text().strip() == "look at", f"{kind}: ⇥ drops the //query, got {text()!r}")
    check("Bug report triage" in (ev("document.getElementById('pm-rail')?.textContent") or ""),
          f"{kind}: ⇥ attaches: the rail names it")

    # ── the rail stays above the chat box as it grows ──
    type_(" " + "and then some more words to make the message wrap onto several lines " * 3, delay=2)
    page.wait_for_timeout(300)
    rail = ev("document.getElementById('pm-rail').getBoundingClientRect().bottom")
    frame = ev("document.querySelector('form').getBoundingClientRect().top")
    check(rail <= frame + 1, f"{kind}: the rail follows the chat box as it grows ({rail} vs {frame})")
    ev("clearAttachments()")

    # ── esc leaves the text alone; URLs never open it ──
    clear()
    type_("hmm //exp")
    page.keyboard.press("Escape")
    check(page.locator("#pm-caret").count() == 0 and text() == "hmm //exp", f"{kind}: esc keeps the text, got {text()!r}")
    type_("l")
    check(page.locator("#pm-caret").count() == 0, f"{kind}: and stays shut for this //")
    clear()
    opened = False
    for ch in "see https://example.com/a":
        page.keyboard.type(ch)
        opened = opened or page.locator("#pm-caret").count() > 0
    check(not opened, f"{kind}: a URL never opens it")

    # ── a draft goes stale while typing, and back when the typing is undone ──
    clear()
    type_("fix the flaky login test")
    ev("E.draft('fix the flaky login test', 'Investigate why the login test fails intermittently and propose a fix.')")
    page.wait_for_timeout(250)
    check(ev("cardState") == "ready" and not ev("cardStale"), f"{kind}: the draft starts fresh")
    page.click(box)
    page.keyboard.press("End")
    type_(" now")
    page.wait_for_timeout(200)
    check(ev("cardStale"), f"{kind}: typing turns the draft stale as it happens")
    for _ in range(4):
        page.keyboard.press("Backspace")
    page.wait_for_timeout(250)
    check(not ev("cardStale"), f"{kind}: undoing the typing makes it fresh again, got {text()!r}")

    # ── // folds the card into the pill ──
    check(ev("cardExpanded"), f"{kind}: the card is open")
    type_(" //rev")
    check(menu_rows() == 1, f"{kind}: // opens over a draft")
    check(not ev("cardExpanded"), f"{kind}: the card folds into the pill while // is open")
    check(ev("document.getElementById('pm-trigger').dataset.state") == "stale", f"{kind}: the pill holds the stale draft (Redo)")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(text() == "fix the flaky login test " + TEMPLATE, f"{kind}: and ↵ still inserts, got {text()!r}")
    check(ev("cardState") == "ready" and not ev("cardExpanded"), f"{kind}: the draft stays in the pill afterwards")
    ev("closeCard()")

    # ── // straight after inserting a rewrite ──
    clear()
    type_("fix the flaky login test")
    ev("E.draft('fix the flaky login test', 'Investigate why the login test fails intermittently.')")
    page.wait_for_timeout(250)
    page.click("#pm-card-accept")
    page.wait_for_timeout(500)
    check(text() == "Investigate why the login test fails intermittently.", f"{kind}: the rewrite went in, got {text()!r}")
    # No click: Insert leaves the keyboard in the chat box, focused from code,
    # and the user carries straight on typing.
    type_(" //rev")
    check(menu_rows() == 1, f"{kind}: // works right after inserting a rewrite")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check(text() == "Investigate why the login test fails intermittently. " + TEMPLATE,
          f"{kind}: and appends to the inserted rewrite, got {text()!r}")
    check(sent() == 1, f"{kind}: without sending")   # the one send is the earlier deliberate Enter

    check(not errors, f"{kind}: page errors {errors}")
    page.close()


def main():
    httpd = serve()
    base = f"http://127.0.0.1:{httpd.server_port}/extension/tests/editors-harness.html"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        for kind in EDITORS:
            run(browser, base, kind)
            print(f"  {kind}: ok")
        browser.close()
    httpd.shutdown()
    print(f"{checks} editor checks PASS ({', '.join(EDITORS)})")


if __name__ == "__main__":
    main()
