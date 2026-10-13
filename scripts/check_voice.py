"""Drive the real content.js through the voice screens in Chrome.

Recording needs a microphone, so the states are entered the way the voice
flow enters them (showVoiceOverlay, updateVoiceOverlayState,
showVoiceTranscriptReview) on extension/tests/pill-harness.html. Checks that
voice sits on the chat box rather than over the page, what each control and
key does, that a transcript under review is never thrown away by a key, and
that a small window gets one line instead of the screen.

Needs Playwright and a local Chrome:
    pip install playwright
    python3 scripts/check_voice.py [--shots DIR]
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
WORDS = ("so I want to write a cold email to a hiring manager for a backend developer role "
         "and make it short and professional with a clear call to action")


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
    ap.add_argument("--shots", help="directory for screenshots")
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
            ev("tips.off = true")

        def rect(sel):
            return ev(f"(() => {{ const r = document.querySelector('{sel}')?.getBoundingClientRect(); return r && {{ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }}; }})()")

        def shot(name):
            if args.shots:
                Path(args.shots).mkdir(parents=True, exist_ok=True)
                page.wait_for_timeout(250)
                page.screenshot(path=str(Path(args.shots) / f"{name}.png"))

        def record():
            ev("voiceState = 'recording'; showVoiceOverlay()")
            page.wait_for_selector("#pm-voice.pm-visible .pm-voice-bar")

        def review(words=WORDS):
            record()
            ev("voiceState = 'transcribing'; updateVoiceOverlayState('transcribing')")
            ev(f"voiceDetectedLanguage = 'en'; showVoiceTranscriptReview({words!r})")
            page.wait_for_selector("#pm-voice-transcript", state="attached")

        load()
        ev("localStorage.clear(); sessionStorage.clear()")
        load()

        # ── recording: a bar on the chat box, not a window over the page ──
        record()
        bar, box = rect("#pm-voice"), rect("form")
        check(bar["h"] <= 60, f"recording is a slim bar, got {bar['h']}px tall")
        check(0 <= box["t"] - bar["b"] <= 16 and abs(bar["r"] - box["r"]) <= 1,
              f"standing on the chat box, its right edge on the box's: {bar} vs {box}")
        top = ev("document.elementFromPoint(innerWidth / 2, 120)?.closest('#pm-voice, .pm-voice-overlay, .pm-modal-overlay')")
        check(top is None, "the conversation stays in view: nothing lies over the middle of the page")
        check(ev("getComputedStyle(document.getElementById('pm-voice')).backdropFilter").find("blur") == -1
              or ev("document.querySelectorAll('.pm-voice-overlay').length") == 0, "and no full-screen blur")
        check(ev("voiceClock(7)") == "0:07" and ev("voiceClock(75)") == "1:15", "the timer reads m:ss")
        labels = [b.strip() for b in page.locator("#pm-voice .pm-card-dock button").all_inner_texts()]
        check(labels == ["Cancel", "Stop"], f"Cancel and Stop, got {labels}")
        check("pm-btn-primary" not in ev("document.getElementById('pm-voice').innerHTML"), "no gradient buttons")
        shot("1-recording")
        page.keyboard.press("Escape")
        page.wait_for_function("!document.querySelector('#pm-voice.pm-visible')")
        check(ev("voiceState") == "idle", "esc while recording cancels it")

        # ── transcribing ──
        record()
        ev("voiceState = 'transcribing'; updateVoiceOverlayState('transcribing')")
        check("Turning your words into text" in page.inner_text("#pm-voice"), "transcribing says what it is doing")
        check("transcribed in" not in page.inner_text("#pm-voice"), "and no timings nobody acts on")
        shot("2-transcribing")
        page.click("#pm-voice-cancel")
        page.wait_for_function("!document.querySelector('#pm-voice.pm-visible')")
        check(ev("voiceState") == "idle", "Cancel stops it")

        # ── review: a card on the chat box ──
        review()
        card, box = rect("#pm-voice"), rect("form")
        check(0 <= box["t"] - card["b"] <= 16, f"the transcript is a card on the chat box: {card} vs {box}")
        check(page.input_value("#pm-voice-transcript") == WORDS, "showing the words, editable")
        check(ev("document.activeElement.id") == "pm-voice-transcript", "with the keyboard in them")
        check(page.inner_text("#pm-voice .pm-card-title").strip().upper() == "YOUR WORDS · EN", "named, with the language heard")
        acts = ev("[...document.querySelectorAll('#pm-voice .pm-card-dock button')].map(b => b.textContent.trim() || b.getAttribute('aria-label'))")
        check(acts == ["Improve", "Use as is", "Discard the transcript"], f"Improve, Use as is, and a bin, got {acts}")
        check(ev("document.getElementById('pm-voice-transcript').scrollHeight <= document.getElementById('pm-voice-transcript').clientHeight + 2"),
              "the box is as tall as the words")
        shot("3-review")

        page.keyboard.press("Escape")
        page.wait_for_selector("#pm-voice.pm-card-tucked .pm-voice-strip .pm-card-strip-gist")
        check(ev("voiceState") == "reviewing" and page.input_value("#pm-voice-transcript") == WORDS,
              "esc folds the transcript to one line; it never throws it away")
        check(rect("#pm-voice")["h"] <= 56, "one line")
        shot("4-folded")
        page.click("#pm-voice-strip .pm-card-strip-open")
        page.wait_for_selector("#pm-voice:not(.pm-card-tucked) #pm-voice-transcript")
        check(ev("document.activeElement.id") == "pm-voice-transcript", "the line opens it again, keyboard back in the words")

        page.fill("#pm-voice-transcript", "edited words for the box")
        ev("H.type('')")
        page.click("#pm-voice-draft")
        page.wait_for_function("!document.querySelector('#pm-voice.pm-visible')")
        check(ev("document.getElementById('composer').textContent") == "edited words for the box", "Use as is puts the edited words in the chat box")
        check(ev("voiceState") == "idle", "and closes it")

        review()
        page.click("#pm-voice-cancel")
        page.wait_for_function("!document.querySelector('#pm-voice.pm-visible')")
        check(ev("voiceState") == "idle", "the bin throws the transcript away")
        check(page.locator("#pm-toast-stack .pm-toast", has_text="discarded").count() >= 1, "and says so")

        ev("window.__improved = null; enhanceVoiceTranscript = (v) => { window.__improved = v; }")
        review()
        page.focus("#pm-voice-transcript")
        page.keyboard.press("Meta+Enter")
        check(ev("window.__improved") == WORDS, "⌘↵ improves the words")
        ev("window.__improved = null")
        page.click("#pm-voice-enhance")
        check(ev("window.__improved") == WORDS, "and so does Improve")
        ev("cleanupVoice()")
        page.wait_for_timeout(250)

        # ── one thing on the chat box at a time ──
        ev("H.type(H.ORIG); H.stream(); H.done()")
        page.wait_for_selector("#pm-card #pm-card-accept")
        record()
        check(not ev("cardExpanded") and ev("cardState") == "ready", "a rewrite card folds into the pill while voice is up, its draft kept")
        ev("cleanupVoice(); closeCard(); H.type('')")
        ev("togglePanel(true)")
        record()
        check(not ev("panelOpen"), "and the library steps aside")
        ev("cleanupVoice()")
        page.wait_for_timeout(250)

        # ── a small window: one line, not the screen ──
        page.set_viewport_size({"width": 1280, "height": 560})
        page.wait_for_timeout(150)
        review()
        check("pm-card-tucked" in page.get_attribute("#pm-voice", "class"), "a short window starts the review folded to one line")
        check(rect("#pm-voice")["h"] <= 56, "one line tall")
        shot("5-small-folded")
        page.click("#pm-voice-strip .pm-card-strip-open")
        page.wait_for_selector("#pm-voice:not(.pm-card-tucked) #pm-voice-transcript")
        v = rect("#pm-voice")
        check(v["t"] >= 0 and v["b"] <= 560, f"opened, it fits the window, got {v}")
        ta = rect("#pm-voice-transcript")
        check(ta["r"] <= v["r"] and ta["l"] >= v["l"], f"and the transcript stays inside it, got {ta} in {v}")
        shot("6-small-open")
        ev("cleanupVoice()")
        page.set_viewport_size({"width": 420, "height": 800})
        page.wait_for_timeout(150)
        review()
        v, ta = rect("#pm-voice"), rect("#pm-voice-transcript")
        check(v["l"] >= 0 and v["r"] <= 420, f"a narrow window: the card fits across it, got {v}")
        page.click("#pm-voice-strip .pm-card-strip-open")
        ta, v = rect("#pm-voice-transcript"), rect("#pm-voice")
        check(ta["r"] <= v["r"] and ta["l"] >= v["l"], f"and the transcript box no longer runs off its edge, got {ta} in {v}")
        ev("cleanupVoice()")

        check(not errors, f"page errors: {errors}")
        browser.close()
    httpd.shutdown()
    print(f"{checks} voice checks PASS")


if __name__ == "__main__":
    main()
