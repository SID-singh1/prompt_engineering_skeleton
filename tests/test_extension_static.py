"""
Static checks over the extension source.

These exist because of a bug that no amount of Python testing could have found
and that a 64-agent code audit also missed: showSetupRequiredModal() built its
modal, inserted it, and wired up its buttons — but never added the `pm-visible`
class that .pm-modal-overlay needs to become opaque. A new user with no account
and no API key typed a prompt, pressed Enhance, and got nothing at all. No
modal, no toast, no console error. It was found by clicking the button on a
real page.

The checks are deliberately crude text analysis. They cannot verify behaviour,
but they catch the specific shape of "a modal that is built and never shown",
which is cheap insurance for a file with seven of them.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CONTENT_JS = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES_CSS = (ROOT / "extension" / "styles.css").read_text(encoding="utf-8")
MANIFEST = (ROOT / "extension" / "manifest.json").read_text(encoding="utf-8")
BACKGROUND_JS = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")


def _function_bodies(src: str, name_pattern: str) -> dict:
    """Crude brace-matched extraction of top-level `function name(...) {...}`."""
    out = {}
    # `async function` too — missing it silently returned an empty dict, and
    # every assertion built on that dict then passed by looking at nothing.
    for m in re.finditer(rf"^(?:async\s+)?function ({name_pattern})\s*\([^)]*\)\s*{{", src, re.M):
        name, i, depth = m.group(1), m.end() - 1, 0
        while i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        out[name] = src[m.start():i + 1]
    return out


MODALS = _function_bodies(CONTENT_JS, r"show\w*Modal")


def test_the_modal_functions_were_actually_found():
    """Guards the extraction itself — an empty dict would pass everything below."""
    assert len(MODALS) >= 3, f"only found {list(MODALS)}"


@pytest.mark.parametrize("name", sorted(MODALS))
def test_every_modal_makes_itself_visible(name):
    """
    A modal that never adds pm-visible is invisible: .pm-modal-overlay is
    opacity:0 / pointer-events:none until the class is present.
    """
    body = MODALS[name]
    if "getOrCreateModalOverlay" not in body and "pm-modal-overlay" not in body:
        pytest.skip(f"{name} does not own an overlay")
    assert "pm-visible" in body, (
        f"{name}() builds a modal but never adds the pm-visible class, "
        "so it is inserted into the page fully transparent and unclickable"
    )


def test_pm_visible_is_what_actually_reveals_the_overlay():
    """The premise of the test above: the class is load-bearing, not cosmetic."""
    assert re.search(r"\.pm-modal-overlay\s*{[^}]*opacity:\s*0", STYLES_CSS, re.S)
    assert re.search(r"\.pm-modal-overlay\.pm-visible\s*{[^}]*opacity:\s*1", STYLES_CSS, re.S)


def test_content_script_matches_cover_every_host_permission_site():
    """
    A site listed in host_permissions but missing from content_scripts.matches
    gets no UI at all. Both lists are hand-maintained.
    """
    import json
    m = json.loads(MANIFEST)
    matches = set(m["content_scripts"][0]["matches"])

    # host_permissions covers two different kinds of host: the chat sites the
    # UI is injected into, and the backends/providers the extension calls.
    # Only the first kind needs a matching content_scripts entry.
    BACKEND_HOSTS = r"(api\.|googleapis|openrouter|hf\.space|localhost|127\.0\.0\.1)"
    chat_hosts = {h for h in m["host_permissions"] if not re.search(BACKEND_HOSTS, h)}

    assert chat_hosts, "no chat hosts found — the exclusion regex is over-matching"
    assert chat_hosts <= matches, f"declared but never injected into: {chat_hosts - matches}"


def test_supported_matches_in_worker_track_the_manifest():
    """
    background.js re-lists the matched sites to re-inject into already-open
    tabs. If that list drifts from the manifest, existing tabs on the missing
    site stay dead after install.
    """
    import json
    worker = (ROOT / "extension" / "background.js").read_text()
    declared = set(json.loads(MANIFEST)["content_scripts"][0]["matches"])
    listed = set(re.findall(r'"(https://[^"]+)"',
                            re.search(r"SUPPORTED_MATCHES = \[(.*?)\]", worker, re.S).group(1)))
    assert listed == declared, f"drifted: only in manifest={declared - listed}, only in worker={listed - declared}"


def test_extension_origins_match_the_manifest():
    """
    config.EXTENSION_ORIGINS drives the production CORS allowlist warning. If it
    drifts from the manifest, either a platform is silently CORS-blocked in
    production or the warning names a site the extension no longer runs on.
    """
    import json
    from backend.core.config import settings

    from_manifest = []
    for pattern in json.loads(MANIFEST)["content_scripts"][0]["matches"]:
        origin = re.match(r"(https://[^/*]+)", pattern).group(1)
        if origin not in from_manifest:
            from_manifest.append(origin)

    assert set(settings.EXTENSION_ORIGINS) == set(from_manifest), (
        f"only in config={set(settings.EXTENSION_ORIGINS) - set(from_manifest)}, "
        f"only in manifest={set(from_manifest) - set(settings.EXTENSION_ORIGINS)}"
    )


# ── the same guard, for the inline card that replaced the modal ──

CARD_FNS = _function_bodies(CONTENT_JS, r"openCard|showDiffModal|showStreamingDiffModal|failStreamingModal")


def test_card_functions_were_found():
    assert "openCard" in CARD_FNS, "openCard not found — the guard below would be vacuous"


def test_opening_the_card_makes_it_visible():
    """
    Same defect class as the invisible setup modal: .pm-card is opacity:0 until
    pm-card-visible is added. Every path that shows the card goes through
    openCard(), so that is the one place the class has to be applied.
    """
    assert "pm-card-visible" in CARD_FNS["openCard"], (
        "openCard() builds and positions the card but never adds pm-card-visible, "
        "so it is inserted fully transparent"
    )


def test_card_visibility_class_is_load_bearing():
    assert re.search(r"\.pm-card\s*{[^}]*opacity:\s*0", STYLES_CSS, re.S)
    assert re.search(r"\.pm-card\.pm-card-visible\s*{[^}]*opacity:\s*1", STYLES_CSS, re.S)


def test_card_keymap_preserves_tab_navigation():
    body = _function_bodies(CONTENT_JS, r"handleCardKeydown")["handleCardKeydown"]
    assert 'e.key === "Tab"' in body
    assert body.index('e.key === "Tab"') < body.index('preventDefault')
    assert 'acceptCard()' not in body


# ── stale rewrites ────────────────────────────────────────────────────────
# Editing the composer after a rewrite arrives leaves the card showing a
# rewrite of text that no longer exists. Accepting it then replaces what the
# user just typed — and reports success, correctly, because the write did land.
# Their work is what gets destroyed, so this is data loss, not untidiness.

def test_function_extraction_finds_async_functions():
    """Guards the helper itself. It matched only `function foo(`, so an async
    function came back as an empty dict and every assertion over it was
    vacuous."""
    assert "acceptCard" in _function_bodies(CONTENT_JS, r"acceptCard")


def test_accept_refuses_a_stale_rewrite():
    """The guard has to be inside acceptCard, not only on the keyboard path —
    the footer button calls it directly."""
    body = _function_bodies(CONTENT_JS, r"acceptCard")["acceptCard"]
    assert "cardStale" in body, "acceptCard does not check staleness at all"
    guard = body.index("cardStale")
    write = body.index("applyOrFallback")
    assert guard < write, "the staleness guard must precede the write"


def test_staleness_is_tracked_as_text_not_a_flag():
    """
    A boolean 'edited' flag cannot be un-set: undoing an edit would strand the
    card as stale forever, and a trailing space would trigger it. Comparing
    normalised text makes undo restore freshness for free.
    """
    body = _function_bodies(CONTENT_JS, r"isStaleAgainstComposer")["isStaleAgainstComposer"]
    assert "cardBasedOn" in body and "norm(" in body, \
        "staleness is not a normalised text comparison"
    refresh = _function_bodies(CONTENT_JS, r"refreshCardStaleness")["refreshCardStaleness"]
    assert "isStaleAgainstComposer()" in refresh


def test_editing_is_actually_listened_for():
    assert 'addEventListener("input", refreshCardStaleness' in CONTENT_JS, \
        "nothing recomputes staleness when the composer changes"


def test_redo_is_manual_not_automatic():
    """
    Re-running on every keystroke would spend a real model call per character
    against a ration of fifteen a day.
    """
    body = _function_bodies(CONTENT_JS, r"refreshCardStaleness")["refreshCardStaleness"]
    assert "handleEnhance" not in body, "staleness detection triggers an enhancement"


def test_the_stale_card_is_visually_distinct_and_labelled():
    assert "pm-card-stale" in CONTENT_JS
    assert "pm-card-head-stale" in STYLES_CSS and '"stale")' in CONTENT_JS, "stale state is dimmed but never explained"
    assert re.search(r"\.pm-card\.pm-card-stale\s*{", STYLES_CSS), \
        "the stale class has no styling, so the state is invisible"


def test_a_rewrite_in_flight_lands_stale_if_the_prompt_moved():
    """
    Staleness is recomputed at render time rather than only on edit, so a
    rewrite the user edited underneath arrives dimmed instead of fresh-and-wrong.
    """
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    assert "cardStale = isStaleAgainstComposer()" in body
    helper = _function_bodies(CONTENT_JS, r"isStaleAgainstComposer")["isStaleAgainstComposer"]
    assert "getCurrentInputText()" in helper


# ── how the stale card looks ──────────────────────────────────────────────
# The first cut of the stale state was correct and unusable. It set
# `background` — not `background-color` — to a 5%-opaque tint, which dropped
# --pm-bg with it and left the card see-through: the host page's own buttons
# read straight through the rewrite, and in the light theme the keycaps went
# white-on-white over a dark page. Correct logic behind an unreadable surface
# is still a broken feature, so these are checks on the surface.


def _stale_css() -> str:
    """The `.pm-card.pm-card-stale { ... }` block."""
    m = re.search(r"\.pm-card\.pm-card-stale\s*{([^}]*)}", STYLES_CSS)
    assert m, "no stale card rule at all"
    return m.group(1)


def test_the_stale_block_was_actually_found():
    """Guards the extractor: an empty string would pass every check below."""
    assert "background" in _stale_css()


def test_the_stale_card_stays_opaque():
    """
    The tint must LAYER over the card's background, never replace it. A
    translucent card lets the host page through the rewrite it is showing.
    """
    block = _stale_css()
    assert not re.search(r"(?<!-)\bbackground\s*:", block), \
        "shorthand `background:` resets background-color — the card goes translucent"
    assert "background-color: var(--pm-bg)" in block, \
        "the stale card does not re-assert an opaque background"


def test_the_warn_palette_is_defined_in_both_themes():
    """
    Every stale colour was written as var(--pm-warn, #hardcoded). None of the
    tokens existed, so the fallback was always what rendered — one dark-tuned
    amber in both themes, at about 2:1 on the light card.
    """
    for token in ("--pm-warn", "--pm-warn-soft", "--pm-warn-border", "--pm-warn-wash"):
        assert STYLES_CSS.count(f"{token}:") >= 2, \
            f"{token} is not defined in both the dark and light blocks"
    assert not re.search(r"var\(--pm-warn[\w-]*,", STYLES_CSS), \
        "a --pm-warn token still carries a hardcoded fallback, which hides a missing token"


def test_the_stale_notice_sits_above_the_rewrite():
    """
    It qualifies the whole card. Printed under the body it read as a second
    content chip, indented beneath the very text it was invalidating. It is
    the card's title bar now, so the card has one anatomy in every state.
    """
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    render = body[body.index("openCard("):]
    assert re.search(r"openCard\(\s*head \+ body", render), \
        "the stale notice is rendered after the body it qualifies"
    assert 'cardHead(' in body and '"stale")' in body


def test_the_card_has_a_minimize_control_that_never_discards():
    """
    A window control in the corner the hand goes to. Minimize folds the draft
    into the pill; discard stays a footer action, deliberately further away.
    """
    head = _function_bodies(CONTENT_JS, r"cardHead")["cardHead"]
    assert 'id="pm-card-min"' in head and "Minimize" in head
    for fn in ("showDiffModal", "showStreamingCardAgain", "failStreamingModal"):
        body = _function_bodies(CONTENT_JS, fn)[fn]
        assert 'getElementById("pm-card-min")?.addEventListener("click", hideCard)' in body, \
            f"{fn} renders a minimize button that does nothing"
    assert ".pm-card-min" in STYLES_CSS


def test_a_minimized_card_stays_minimized():
    """
    A rewrite that finishes after the user minimized it lands in the pill,
    not over whatever they moved on to. A NEW result still shows itself.
    """
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    assert 'if (result !== cardResult && cardState !== "streaming") cardMinimized = false;' in body
    assert "if (cardMinimized) { renderPill(); return; }" in body
    assert "cardMinimized = true" in _function_bodies(CONTENT_JS, r"hideCard")["hideCard"]
    assert "cardMinimized = false" in _function_bodies(CONTENT_JS, r"expandCard")["expandCard"]


def test_the_card_comes_back_the_way_it_was_left():
    """Open or minimized survives a reload with the draft."""
    assert "expanded: !cardMinimized" in _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    restore = _function_bodies(CONTENT_JS, r"restoreDraft")["restoreDraft"]
    assert "if (draft.expanded) showDiffModal(cardResult);" in restore
    assert "draftStore.setExpanded(false)" in _function_bodies(CONTENT_JS, r"hideCard")["hideCard"]


def test_the_stale_footer_still_lists_the_keys_that_still_work():
    """
    The stale footer was a separate, shorter list that dropped \\ original and
    ⌘S save — while both key handlers stayed live. A footer that stops listing
    working keys teaches you to stop reading it.
    """
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    actions = body[body.index("const actions ="):body.index("openCard(")]
    for el in ("pm-card-toggle", "pm-card-save", "pm-card-close"):
        assert el in actions, f"{el} is missing from the one shared footer"
    # Accept is the only thing that differs between the two states.
    assert "pm-card-disabled" in body and "pm-card-redo" in body


def test_the_reading_position_survives_going_stale():
    """
    Going stale re-renders the card. Without this the rewrite scrolled back to
    the top exactly when the user edited in reaction to something they had
    scrolled down to read.
    """
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    assert "scrollTop" in body, "the rewrite's scroll position is discarded on re-render"
    assert "textContent === prevContent" in body, \
        "scroll is restored without checking the text is the same text"


def test_the_card_is_never_positioned_over_the_composer():
    """
    positionCard clamped the card's TOP against the viewport bottom, so a card
    too tall to fit below slid upward over the composer — covering the text it
    is a comment on, and doing it precisely when the stale bar made it taller.
    The fix constrains the scrolling text instead.
    """
    body = _function_bodies(CONTENT_JS, r"positionCard")["positionCard"]
    assert "--pm-card-text-max" in body, \
        "nothing constrains the card's height to the room beside the composer"
    assert not re.search(r"Math\.min\(\s*box\.bottom \+ gap", body), \
        "the card's top is still clamped against the viewport, which walks it over the composer"
    assert "min(40vh, var(--pm-card-text-max" in STYLES_CSS, \
        "the height budget positionCard computes is never applied to the text"


# ── toasts ────────────────────────────────────────────────────────────────
# Every toast positioned itself, identically: `position: fixed; bottom: 80px;
# left: 50%`. Two at once therefore landed on the same pixels. Accepting a
# rewrite did exactly that — applyOrFallback raised "Applied" and the rating
# prompt covered it a frame later, so the answer to "did that work?" was never
# visible. And at z-index 100003 against the card's 2147483000, a toast raised
# while the card was open rendered behind it: ⌘S showed a sliver of "Saved to
# your library" poking out from under the card it was confirming.


def _css_block(selector: str) -> str:
    """
    The block for a rule whose selector is exactly `selector`.

    Naive matching grabs the wrong rule: `.pm-toast` also appears as the last
    entry of a grouped `.pm-panel, ..., .pm-toast { transition: ... }` selector,
    where it sits at the start of its own line and matches identically. Skipping
    matches preceded by a comma is what makes this the standalone rule.
    """
    for m in re.finditer(re.escape(selector) + r"\s*{([^}]*)}", STYLES_CSS):
        if STYLES_CSS[: m.start()].rstrip().endswith(","):
            continue
        return m.group(1)
    raise AssertionError(f"no standalone rule for {selector}")


def test_the_toast_blocks_were_actually_found():
    """Guards the extractor — an empty string passes every check below."""
    assert "position" in _css_block("#pm-toast-stack")
    assert "padding" in _css_block(".pm-toast")


def test_toasts_do_not_position_themselves():
    """
    Individually-positioned toasts stack on the same pixels. Layout is the
    container's job so that two toasts lay out instead of overlapping.
    """
    for sel in (".pm-toast",):
        block = _css_block(sel)
        assert "position: fixed" not in block, f"{sel} still positions itself"
        assert "bottom:" not in block, f"{sel} still pins itself to the viewport"


def _z_of(selector: str) -> int:
    """The effective level of a rule, resolved through the shared scale."""
    decl = re.search(r"z-index:\s*([^;]+);", _css_block(selector))
    assert decl, f"{selector} declares no z-index"
    value = decl.group(1).strip()
    token = re.fullmatch(r"var\((--pm-z-[a-z]+)\)", value)
    assert token, f"{selector} hardcodes {value!r} instead of using the scale"
    return _z_scale()[token.group(1)]


def test_the_toast_stack_outranks_the_card():
    """
    A toast that loses the z-index race to the card is an invisible message.
    """
    assert _z_of("#pm-toast-stack") > _z_of(".pm-card"), "toasts render behind the card"


def test_the_toast_stack_does_not_swallow_clicks():
    """Toasts are passive now — the rating question moved into the pill — so
    the whole stack stays transparent to the pointer."""
    assert "pointer-events: none" in _css_block("#pm-toast-stack")


def test_accepting_reports_once_in_the_pill():
    """
    The confirmation and the rating prompt are one event, and the pill is the
    object the user was looking at. Two toasts for it meant the second covered
    the first; a toast beside a collapsed pill meant two objects for one event.
    """
    body = _function_bodies(CONTENT_JS, r"acceptCard")["acceptCard"]
    assert "applyOrFallback(text, null)" in body, \
        "applyOrFallback is not told to stay quiet when the pill will confirm"
    assert "showApplied(canRate ? result : null)" in body
    apply_body = _function_bodies(CONTENT_JS, r"applyOrFallback")["applyOrFallback"]
    assert "if (successMessage) showToast" in apply_body, \
        "applyOrFallback toasts unconditionally, so accept still fires two"
    rate = _function_bodies(CONTENT_JS, r"ratePill")["ratePill"]
    assert "sendFeedback(a.result.log_id, rating, a.result.original, a.result.enhanced)" in rate


def test_the_rating_prompt_is_skipped_when_it_cannot_be_sent():
    """Without a log_id the rating goes nowhere; asking anyway spends attention
    on nothing, and drops the confirmation to show a dead question."""
    body = _function_bodies(CONTENT_JS, r"acceptCard")["acceptCard"]
    assert "result.log_id" in body


def test_passive_memory_is_approved_only_after_enhanced_text_is_applied():
    body = _function_bodies(CONTENT_JS, r"acceptCard")["acceptCard"]
    assert "const applyingEnhanced = !cardShowingOriginal" in body
    assert "if (applied && applyingEnhanced && result.log_id)" in body
    assert "await approveEnhancement(result.log_id)" in body
    approval = _function_bodies(CONTENT_JS, r"approveEnhancement")["approveEnhancement"]
    assert '`${API_URL}/enhance/accept`' in approval
    assert "JSON.stringify({ log_id: logId })" in approval


def test_toasts_carry_a_theme():
    """
    Toasts set no data-pm-theme at all, so they resolved --pm-bg from :root and
    rendered dark for everyone regardless of the setting.
    """
    body = _function_bodies(CONTENT_JS, r"getOrCreateToastStack")["getOrCreateToastStack"]
    assert "data-pm-theme" in body and "pm_theme" in body


def test_switching_theme_repaints_the_card_and_the_toasts():
    """
    applyTheme listed the panel, trigger and overlays but not the card or the
    toasts — the two surfaces most likely to be on screen when you toggle.
    """
    body = _function_bodies(CONTENT_JS, r"applyTheme")["applyTheme"]
    assert "pm-card" in body and "pm-toast-stack" in body


def test_lazy_created_modal_inherits_the_current_theme():
    """A modal created after theme setup must not fall back to dark :root tokens.
    It read the theme off the old panel; the panel is gone, so the theme is
    held in uiTheme, which applyTheme() and the stored setting both write."""
    body = _function_bodies(CONTENT_JS, r"getOrCreateModalOverlay")["getOrCreateModalOverlay"]
    assert "data-pm-theme" in body and "uiTheme" in body
    assert "uiTheme = theme" in _function_bodies(CONTENT_JS, r"applyTheme")["applyTheme"]


def test_lazy_created_voice_overlay_inherits_the_current_theme():
    """The on-demand voice overlay must use the active theme."""
    body = _function_bodies(CONTENT_JS, r"showVoiceOverlay")["showVoiceOverlay"]
    assert "data-pm-theme" in body and "uiTheme" in body


def test_voice_flow_requires_review_before_it_can_enhance():
    """A spoken draft must be editable, cancellable, and bounded before LLM use."""
    start = _function_bodies(CONTENT_JS, r"startVoice")["startVoice"]
    transcribe = _function_bodies(CONTENT_JS, r"transcribeVoiceAudio")["transcribeVoiceAudio"]
    review = _function_bodies(CONTENT_JS, r"showVoiceTranscriptReview")["showVoiceTranscriptReview"]

    assert "VOICE_MAX_RECORDING_SECONDS" in CONTENT_JS
    assert "getVoiceAuthToken" in start
    assert "supportedVoiceMimeType" in start
    assert "/voice-transcribe" in transcribe
    assert "AbortController" in transcribe
    assert "Enhance transcript" in review
    assert "Use as draft" in review
    assert "cancelVoice" in review
    assert "voice-enhance" not in transcribe


def test_voice_result_keeps_the_composer_stale_write_guard():
    body = _function_bodies(CONTENT_JS, r"enhanceVoiceTranscript")["enhanceVoiceTranscript"]
    assert "voiceComposerBaseline" in body
    assert "cardHasBaseline" in body


def test_builder_dashboard_never_persists_its_bearer_key_or_accepts_any_https_api():
    """A dashboard URL must not turn its key header into an exfiltration channel."""
    dashboard_js = (ROOT / "website" / "builder.js").read_text(encoding="utf-8")
    assert "LOCAL_API_URLS" in dashboard_js
    assert "url.origin === DEFAULT_API_URL" in dashboard_js
    assert "sessionStorage" not in dashboard_js
    assert "dashboard-notice" in dashboard_js


def test_toasts_are_placed_above_the_card_not_over_it():
    """
    Anchoring to the card alone breaks the empty-chat layout, where the card
    renders BELOW the composer — the toast would land on the composer.
    """
    body = _function_bodies(CONTENT_JS, r"positionToasts")["positionToasts"]
    assert "findComposer()" in body and "pm-card" in body, \
        "positionToasts does not consider both anchors"
    assert "Math.min(...tops)" in body, \
        "the stack is not placed above the highest of card and composer"


# ── where sign-in puts you ────────────────────────────────────────────────
# The auth tab was created from a bare { url } and removed again with nothing
# activated in its place, so Chrome picked whatever got focus next. Signing in
# dropped people on an unrelated page — not a redirect to the wrong place, but
# the absence of one.


def _auth() -> str:
    return _function_bodies(BACKGROUND_JS, r"startGoogleAuth")["startGoogleAuth"]


def test_the_auth_flow_was_actually_found():
    """Guards the extractor — an empty body passes everything below."""
    assert "chrome.tabs.create" in _auth()


def test_sign_in_records_where_the_user_came_from():
    body = _auth()
    assert "sender?.tab" in body, \
        "the options page's own tab is never considered as the origin"
    assert "lastFocusedWindow" in body, \
        "the toolbar popup path has no origin tab, since sender.tab is undefined there"


def test_the_auth_tab_is_opened_from_the_origin_tab():
    """
    openerTabId also requires the opener to be in the same window, so windowId
    has to travel with it or the create call is rejected.
    """
    body = _auth()
    assert "openerTabId" in body
    assert "windowId" in body


def test_focus_returns_to_the_origin_after_the_auth_tab_closes():
    body = _auth()
    assert "restoreOriginTab(origin)" in body, "nothing puts the user back"
    assert body.index("tabs.remove") < body.index("restoreOriginTab(origin)"), \
        "focus is restored before the auth tab is closed, which the close then undoes"


def test_focus_is_only_restored_when_the_extension_closed_the_tab():
    """
    A user who closes the auth tab themselves has chosen where to look. Pulling
    focus back would override a deliberate action, so the restore belongs on the
    success path only — not on the cancellation branch.
    """
    body = _auth()
    assert body.count("restoreOriginTab(origin)") == 1
    assert body.index("restoreOriginTab(origin)") < body.index("Sign-in was cancelled"), \
        "focus is restored on the cancellation path too"


def test_restoring_focus_cannot_fail_a_sign_in_that_succeeded():
    """The origin tab is free to vanish while Google is loading."""
    body = _function_bodies(BACKGROUND_JS, r"restoreOriginTab")["restoreOriginTab"]
    assert "try {" in body and "catch" in body


def test_the_origin_tab_is_read_without_needing_the_tabs_permission():
    """
    Tab.url and Tab.title are stripped unless the extension holds "tabs" or a
    host permission for that page — they would read as undefined rather than
    fail, which is the quiet kind of wrong. Only id/index/windowId are safe, and
    they are all this needs.
    """
    import json
    body = _auth()
    for field in ("origin.url", "origin?.url", "origin.title", "origin?.title"):
        assert field not in body, f"{field} is unavailable without the tabs permission"
    assert "tabs" not in json.loads(MANIFEST)["permissions"], \
        "the sign-in fix should not have needed a broader permission"


# ── stacking order ────────────────────────────────────────────────────────
# Seven z-index values picked ad hoc at six different times: 99998, 99999,
# 100001, 100002, 2147483000, 2147483100. Every layering bug found was that
# — toasts behind the card, the card over the panel, the card punching through
# the full-screen voice and modal backdrops. One declared scale replaces them.

Z_TOKENS = ("--pm-z-trigger", "--pm-z-card", "--pm-z-library", "--pm-z-overlay", "--pm-z-toast")


def _z_scale() -> dict:
    return {
        t: int(re.search(rf"{t}:\s*(\d+);", STYLES_CSS).group(1))
        for t in Z_TOKENS
    }


def test_the_z_scale_was_actually_found():
    """Guards the extractor — a missing token would KeyError, an empty one pass."""
    assert len(_z_scale()) == len(Z_TOKENS)


def test_the_stacking_order_is_declared_not_inferred():
    """The tokens must ascend in the order they are written, or the scale is
    just seven more arbitrary numbers with nicer names."""
    z = _z_scale()
    order = [z[t] for t in Z_TOKENS]
    assert order == sorted(order), f"tokens are not in ascending order: {z}"
    assert len(set(order)) == len(order), "two surfaces share a level"


def test_nothing_covers_the_card_that_does_not_also_take_its_keys():
    """
    The card's keys act on what it shows. Anything painted over it while its
    keymap is live means acting on something you cannot see. The library sits
    above the card, and takes the keyboard when it opens: the card's keymap
    only answers with focus in the card, the pill or the chat box. The full-
    screen overlays above it disable the keymap outright.
    """
    z = _z_scale()
    assert z["--pm-z-library"] > z["--pm-z-card"]
    assert "focusLibrarySearch()" in _function_bodies(CONTENT_JS, r"togglePanel")["togglePanel"], \
        "the library covers the card without taking its keys"
    assert z["--pm-z-overlay"] > z["--pm-z-card"], \
        "the card punches through the full-screen modal and voice backdrops"
    body = _function_bodies(CONTENT_JS, r"overlayHasInput")["overlayHasInput"]
    assert "pm-modal-overlay.pm-visible" in body and "pm-voice-overlay.pm-visible" in body


def test_the_card_keymap_defers_to_an_overlay():
    assert re.search(r"if \([^\n]*overlayHasInput\(\)\) return;", CONTENT_JS), \
        "the card still answers Tab while a modal owns input"


def test_toasts_sit_above_everything():
    z = _z_scale()
    assert z["--pm-z-toast"] == max(z.values()), \
        "a status message that loses a z-index race is not a degraded message, it is none"


def test_no_page_level_surface_hardcodes_its_own_level():
    """
    The one remaining literal is local: the library's ⋯ menu is `position:
    absolute` inside the sheet, which is fixed and z-indexed and so its own
    stacking context; the 1 says nothing about page-level order.
    """
    literals = re.findall(r"z-index:\s*(\d+);", STYLES_CSS)
    assert literals == ["1"], f"unscaled page-level z-index: {literals}"
    assert "z-index: 1;" in _css_block(".pm-lib .pm-lib-menu")


def test_the_scale_clears_host_page_overlays():
    """ChatGPT's own overlays sat above the old 99998, so the panel could be
    buried by the page it runs on."""
    assert min(_z_scale().values()) > 1_000_000


# ── the card and the library ──────────────────────────────────────────────
# The old panel took a column of the page and the card had to keep out of it.
# The library is a sheet on the pill, opened on purpose and closed by the next
# click elsewhere, so while it is up it sits above the card instead.

def test_the_library_sits_above_the_card_while_open():
    z = _z_scale()
    assert z["--pm-z-card"] < z["--pm-z-library"] < z["--pm-z-overlay"], \
        "the library must cover the card, and modals it raises must cover it"
    body = _function_bodies(CONTENT_JS, r"positionCard")["positionCard"]
    assert "#pm-panel" not in body, "the card still reserves a column for a panel that no longer exists"
    assert "Math.min(left, rightBound - width)" in body, \
        "the card is not held inside the boundary it computed"


def test_the_library_closes_on_a_click_elsewhere():
    create = _function_bodies(CONTENT_JS, r"createLibrary")["createLibrary"]
    assert 'addEventListener("pointerdown"' in create and "togglePanel(false)" in create


def test_the_card_relayouts_when_the_library_opens():
    """Opening and closing the library fire neither resize nor scroll, which
    are the only events the card watches; placePill() re-runs positionCard()."""
    toggle = _function_bodies(CONTENT_JS, r"togglePanel")["togglePanel"]
    assert "placePill()" in toggle, "opening the library leaves the pill and card where they were"
    assert "positionCard()" in _function_bodies(CONTENT_JS, r"placePill")["placePill"]


# ── readability ───────────────────────────────────────────────────────────

def test_the_daily_count_speaks_up_only_when_it_decides_something():
    """The count used to be a bar at every level, and at 15/15 its number was
    the dimmest text in the panel. It is now a coloured line in the library's
    foot at three or fewer left, and a plain line in ⋯."""
    foot = _function_bodies(CONTENT_JS, r"libFootHtml")["libFootHtml"]
    assert "left <= 3" in foot and "pm-lib-low" in foot and "No rewrites left today" in foot
    assert "color" in _css_block(".pm-lib .pm-lib-low")
    assert "rewrites used today" in _function_bodies(CONTENT_JS, r"libMenuHtml")["libMenuHtml"]


def test_a_scroller_with_more_below_says_so():
    """Both scrollers cut their last row dead, which reads as a rendering fault
    rather than an invitation to keep going."""
    body = _function_bodies(CONTENT_JS, r"markScrollable")["markScrollable"]
    assert "scrollHeight" in body and "pm-scroll-more" in body
    assert "mask-image" in _css_block(".pm-scroll-more")


def test_the_fade_is_removed_at_the_bottom():
    """Dimming the final line when there is nothing beyond it is the original
    complaint with extra steps."""
    body = _function_bodies(CONTENT_JS, r"markScrollable")["markScrollable"]
    assert "classList.toggle" in body, "the fade is added but never taken away"


def test_both_clipped_scrollers_are_wired_up():
    for fn in ("showDiffModal", "afterListRender"):
        body = _function_bodies(CONTENT_JS, fn)[fn]
        assert "markScrollable" in body, f"{fn} never marks its scroller"


def test_async_history_render_refreshes_the_scroll_marker():
    """History arrives after the first measurement and must re-mark its list:
    Recent redraws through renderLibrary(), which ends in afterListRender()."""
    click = _function_bodies(CONTENT_JS, r"onLibraryClick")["onLibraryClick"]
    assert re.search(r"fetchEnhanceHistory\(\)\.then\([^\n]*renderLibrary\(\)", click)
    assert "afterListRender(lib)" in _function_bodies(CONTENT_JS, r"renderLibrary")["renderLibrary"]


def test_async_feedback_render_refreshes_the_scroll_marker():
    """Recent feedback arrives asynchronously and can make the page scrollable."""
    body = _function_bodies(CONTENT_JS, r"loadRecentFeedback")["loadRecentFeedback"]
    assert "markScrollable(page)" in body


# ── the library is reachable without knowing about shift ──────────────────

def test_the_library_has_a_visible_way_in():
    """
    Shift-clicking a plus sign was the only route to the panel, and therefore to
    the saved-prompt checkboxes that decide which context shapes a rewrite. The
    feature read as removed.
    """
    assert 'lib.id = "pm-library-btn"' in CONTENT_JS
    assert "togglePanel()" in CONTENT_JS[CONTENT_JS.index('lib.id = "pm-library-btn"'):][:600]


def test_the_library_button_follows_the_trigger_in_the_dom():
    """The keyboard reveal is a sibling selector, so order is load-bearing."""
    assert CONTENT_JS.index('btn.id = "pm-trigger"') < CONTENT_JS.index('lib.id = "pm-library-btn"')
    assert ".pm-trigger:focus-visible ~ .pm-library-btn" in STYLES_CSS


def test_the_chip_survives_the_trip_from_the_plus():
    """
    The pointer reveal was `.pm-trigger:hover ~ .pm-library-btn`, which lasted
    only while the pointer was on ⊕: crossing the gap lost it and the chip
    faded from under the click. A bridge over the gap pointed one way only,
    and the chip moves to either side of the pill, or above it. Pointer intent
    over both, with a grace period on leaving, covers any gap in any direction.
    """
    assert ".pm-trigger:hover ~ .pm-library-btn" not in STYLES_CSS
    assert ".pm-library-btn.pm-lib-reveal" in STYLES_CSS
    create = _function_bodies(CONTENT_JS, r"createTrigger")["createTrigger"]
    assert "for (const el of [btn, lib])" in create
    assert 'addEventListener("pointerenter", revealChip)' in create
    assert 'addEventListener("pointerleave", concealChip)' in create
    assert re.search(r"setTimeout\(\(\) => lib\.classList\.remove\(\"pm-lib-reveal\"\), \d{3}\)", create), \
        "leaving must hide the chip after a grace period, not at once"


def test_the_primary_action_is_unchanged():
    """Click on ⊕ stays enhance. The library used to be the front door and the
    primary action sat two clicks behind a tab bar; this does not undo that."""
    assert re.search(
        r"if \(e\.shiftKey\) togglePanel\(\);\s*\n\s*else if \(pillApplied\) clearApplied\(\);[^\n]*\n\s*else handleEnhance\(\);",
        CONTENT_JS,
    )


def test_the_library_button_is_reachable_by_keyboard():
    assert ".pm-library-btn:focus-visible" in STYLES_CSS


def test_the_library_button_is_themed():
    """Every surface that reads --pm-bg needs the attribute or it resolves :root
    and renders dark for everyone — the bug the toasts had."""
    assert 'lib.setAttribute("data-pm-theme"' in CONTENT_JS
    body = _function_bodies(CONTENT_JS, r"applyTheme")["applyTheme"]
    assert "pm-library-btn" in body


# ── saving reports what actually happened ─────────────────────────────────
# createSavedPrompt toasted "This prompt is already saved" from inside itself
# and then returned true, so the caller announced its own success over the top.
# showToast replaces the toast on screen, so the accurate message was destroyed
# by the inaccurate one a frame later: saving the same prompt twice reported
# "Saved to your library" for something that had not been saved.


def test_creating_a_saved_prompt_reports_an_outcome_not_a_boolean():
    """A boolean cannot distinguish "written" from "already there", which is
    what let one value mean both "fine" and "nothing happened"."""
    body = _function_bodies(CONTENT_JS, r"createSavedPrompt")["createSavedPrompt"]
    for outcome in ('"saved"', '"duplicate"', '"failed"'):
        assert outcome in body, f"createSavedPrompt never returns {outcome}"
    assert "return true" not in body and "return false" not in body


def test_the_data_call_does_not_raise_its_own_toast():
    """Two writers to one toast is how the contradiction happened."""
    body = _function_bodies(CONTENT_JS, r"createSavedPrompt")["createSavedPrompt"]
    assert "showToast" not in body


def test_a_duplicate_save_is_not_reported_as_a_save():
    card = _function_bodies(CONTENT_JS, r"saveCard")["saveCard"]
    assert '"duplicate"' in card, "saveCard cannot tell a duplicate from a write"
    assert card.index('"duplicate"') < card.index("Saved to your library"), \
        "the duplicate case falls through to the success message"


def test_a_duplicate_save_from_the_library_is_not_reported_as_a_save():
    """The Save tab's form is now the library's Save row. A duplicate must say
    so, and must not refetch as though something had been written."""
    body = _function_bodies(CONTENT_JS, r"libSaveText")["libSaveText"]
    saved = body[body.index('if (outcome === "saved")'):body.index("} else {")]
    assert "fetchSavedPrompts" in saved
    rest = body[body.index("} else {"):]
    assert "Already in your library" in rest and "fetchSavedPrompts" not in rest


# ── the pill: the draft outlives the composer ─────────────────────────────
# The card held its result in module variables and anchored to the composer.
# Switch chats and the composer is gone; reload and the rewrite is gone. The
# ⊕ button now holds the draft (as a pill), the card hangs off the pill, and
# the draft is written through to extension storage.


def test_the_trigger_is_the_pill():
    """One object: the ⊕ grows into the draft holder rather than a second
    floating thing appearing next to it."""
    body = _function_bodies(CONTENT_JS, r"createTrigger")["createTrigger"]
    for part in ("pm-pill-glyph", "pm-pill-dot", "pm-pill-label", "pm-pill-insert", "pm-pill-x"):
        assert part in body, f"the pill is missing its {part}"
    assert 'btn.setAttribute("role", "button")' in body and 'tabindex' in body, \
        "a div trigger must restore what <button> gave for free"


def test_the_pill_grows_away_from_its_docked_edge():
    """Anchored with left/right, never absolute x, so a draft arriving makes
    the pill grow into the page instead of off-screen."""
    body = _function_bodies(CONTENT_JS, r"placePill")["placePill"]
    assert 'pillDock === "left"' in body and 'pillDock === "right"' in body
    assert re.search(r"\.pm-trigger\[data-dock=\"left\"\]\s*{\s*flex-direction:\s*row;", STYLES_CSS), \
        "docked left the row must not reverse — it renders the pill backwards"


def test_the_idle_pill_is_still_a_round_button():
    """With no draft the label collapses to nothing and there is no flex gap,
    so the ⊕ sits centred in a circle. The label opens on a grid track
    (0fr → 1fr) because that is the one transition that animates to auto."""
    assert re.search(r"\.pm-pill-labelwrap\s*{[^}]*grid-template-columns:\s*0fr", STYLES_CSS, re.S)
    trigger = re.search(r"\.pm-trigger\s*{([^}]*)}", STYLES_CSS, re.S).group(1)
    assert re.search(r"gap:\s*0\s*;", trigger), "the collapsed label still costs a gap"
    assert re.search(r"\.pm-trigger\.pm-pill-open\s*{\s*gap:", STYLES_CSS)


def test_the_draft_is_written_through_to_storage():
    """Session storage: survives navigation and reloads, dies with the browser,
    is shared across the matched sites."""
    assert "chrome.storage.session" in CONTENT_JS
    body = _function_bodies(CONTENT_JS, r"showDiffModal")["showDiffModal"]
    assert "draftStore.save(" in body, "a finished rewrite is never persisted"
    assert "restoreDraft()" in _function_bodies(CONTENT_JS, r"init")["init"]


def test_the_worker_opens_session_storage_to_content_scripts():
    """Without setAccessLevel every session.get() in the page rejects and the
    store silently falls back to local storage."""
    assert "setAccessLevel" in BACKGROUND_JS
    assert "TRUSTED_AND_UNTRUSTED_CONTEXTS" in BACKGROUND_JS


def test_escape_hides_a_finished_draft_but_discards_a_failed_one():
    """Esc on a finished rewrite tucks it into the pill. A first stream in
    flight or an error has nothing worth keeping; a style rerun in flight goes
    back to the version it started from (cancelStreaming decides which)."""
    assert re.search(r'if \(cardState === "ready"\) hideCard\(\);\s*'
                     r'else if \(cardState === "streaming"\) cancelStreaming\(\);\s*'
                     r'else closeCard\(\);', CONTENT_JS)
    cancel = _function_bodies(CONTENT_JS, r"cancelStreaming")["cancelStreaming"]
    assert "!cardRerunFrom) { closeCard(); return; }" in cancel, \
        "a first rewrite in flight must still be discarded on Esc"
    body = _function_bodies(CONTENT_JS, r"hideCard")["hideCard"]
    assert "cardState" not in body and "draftStore.clear" not in body, \
        "hideCard must leave the draft intact"
    close = _function_bodies(CONTENT_JS, r"closeCard")["closeCard"]
    assert "draftStore.clear()" in close, "discarding must also clear storage"


def test_an_empty_composer_is_not_stale():
    """A fresh chat with an empty box is where a draft that followed the user is
    meant to land. Only text that is NOT the baseline can be destroyed."""
    body = _function_bodies(CONTENT_JS, r"isStaleAgainstComposer")["isStaleAgainstComposer"]
    assert 'now !== ""' in body


def test_the_pill_click_does_not_respend_quota_on_the_same_text():
    """A click with a draft pending and an unchanged (or empty) composer opens
    the draft. New text in the composer means a new enhancement."""
    body = _function_bodies(CONTENT_JS, r"reopenDraftIfRelevant")["reopenDraftIfRelevant"]
    assert "now && now !== cardBasedOn" in body
    handle = _function_bodies(CONTENT_JS, r"handleEnhance")["handleEnhance"]
    assert handle.index("reopenDraftIfRelevant(") < handle.index("getCurrentInputText()")


def test_the_shortcut_shows_a_draft_but_never_hides_it():
    """Pressed twice on one draft, the shortcut used to hide the card it had
    just shown. Both of its paths ask handleEnhance to reveal."""
    assert CONTENT_JS.count("handleEnhance({ reveal: true })") == 2
    body = _function_bodies(CONTENT_JS, r"reopenDraftIfRelevant")["reopenDraftIfRelevant"]
    assert "if (reveal) revealCard();" in body
    reveal = _function_bodies(CONTENT_JS, r"revealCard")["revealCard"]
    assert "hideCard" not in reveal and "toggleCard" not in reveal


def test_navigation_is_watched_and_rejudges_the_draft():
    """The hosts pushState without any event; the URL is polled."""
    body = _function_bodies(CONTENT_JS, r"watchNavigation")["watchNavigation"]
    assert "popstate" in body and "setInterval(check" in body
    nav = _function_bodies(CONTENT_JS, r"onNavigated")["onNavigated"]
    assert "refreshCardStaleness()" in nav and "renderPill()" in nav


def test_a_drag_never_fires_the_click_it_ends_with():
    """pointerup on the same element raises click; a drag must swallow it or
    every reposition also spends an enhancement."""
    body = _function_bodies(CONTENT_JS, r"setupPillDrag")["setupPillDrag"]
    assert "pillSuppressClick = true" in body
    assert "stopImmediatePropagation" in _function_bodies(CONTENT_JS, r"createTrigger")["createTrigger"]


def test_the_pill_position_is_remembered_per_host():
    assert "pm_pill_pos:${window.location.hostname}" in CONTENT_JS
    body = _function_bodies(CONTENT_JS, r"setupPillDrag")["setupPillDrag"]
    assert "storageSet({ [pillStorageKey()]" in body


def test_the_card_still_clears_the_composer():
    body = _function_bodies(CONTENT_JS, r"positionCard")["positionCard"]
    assert 'document.getElementById("pm-trigger")' in body, "the card no longer knows where the pill is"
    assert "overlapsComposer" in body, "the card may cover the text it is a comment on"


def test_render_pill_is_cheap_on_keystrokes():
    """It runs from the document-wide input listener, so it must bail before
    touching the DOM when nothing it shows has changed."""
    body = _function_bodies(CONTENT_JS, r"renderPill")["renderPill"]
    assert "pillSignature" in body and "if (sig === pillSignature) return;" in body


# ── the floating console is black on every page ───────────────────────────
# The pill, card, library button and toasts are one object family that floats
# OVER the host page. They deliberately do not theme with it: --pm-bg-panel
# inverted to white under [data-pm-theme="light"], which is exactly why the
# old trigger could not be black.


def _light_block() -> str:
    m = re.search(r'\[data-pm-theme="light"\]\s*{([^}]*)}', STYLES_CSS, re.S)
    assert m, "no light theme block"
    return m.group(1)


def test_the_console_palette_never_flips_with_the_theme():
    """A token the light theme redefines is a token the pill cannot rely on."""
    light = _light_block()
    for token in ("--pm-con-bg", "--pm-con-text", "--pm-con-border", "--pm-con-bg-solid"):
        assert f"{token}:" in STYLES_CSS, f"{token} is never defined"
        assert f"{token}:" not in light, \
            f"{token} is redefined in the light theme — the console would stop being black"


def test_the_pill_wears_the_console_palette_not_the_page_one():
    trigger = re.search(r"\.pm-trigger\s*{([^}]*)}", STYLES_CSS, re.S).group(1)
    assert "var(--pm-con-bg)" in trigger, "the pill still takes its background from the theme"
    assert "--pm-bg-panel" not in trigger, "the pill still reads the theming panel token"


def test_the_card_pins_the_console_palette_instead_of_rewriting_its_rules():
    """
    Custom properties cascade, so redefining the theme tokens ON the card makes
    every rule inside it — the stale variant included — resolve to the console
    palette untouched. The stale rules still read var(--pm-bg); this is what
    makes that dark on a light page.
    """
    card = re.search(r"\.pm-card\s*{([^}]*)}", STYLES_CSS, re.S).group(1)
    assert "--pm-bg: var(--pm-con-bg-solid)" in card
    assert "--pm-text: var(--pm-con-text)" in card
    for token in ("--pm-warn", "--pm-warn-soft", "--pm-warn-border", "--pm-warn-wash"):
        assert f"{token}:" in card, f"{token} is not pinned, so the stale card half-themes"


def test_the_open_pill_drops_the_glyph_rather_than_only_shrinking():
    """
    Removing an element is what makes the open pill thin; the status light and
    the preview already say everything the ⊕ did.
    """
    assert re.search(r"\.pm-trigger\.pm-pill-open \.pm-pill-glyph\s*{[^}]*width:\s*0", STYLES_CSS)
    assert re.search(r"\.pm-trigger\.pm-pill-open \.pm-pill-dot\s*{[^}]*width:\s*6px", STYLES_CSS)


def test_the_idle_pill_is_a_circle():
    """32px tall, 32px min-width, fully rounded, no padding to push the ⊕ off
    centre — the glyph is its own 30px square inside the 1px border. 32 rather than 36 so the pill
    reads as lighter than the hosts' 32–36px send buttons, not as a peer."""
    trigger = re.search(r"\.pm-trigger\s*{([^}]*)}", STYLES_CSS, re.S).group(1)
    assert "height: 32px" in trigger and "min-width: 32px" in trigger
    assert "border-radius: 16px" in trigger
    glyph = re.search(r"\.pm-pill-glyph\s*{([^}]*)}", STYLES_CSS, re.S).group(1)
    assert "width: 30px" in glyph and "height: 30px" in glyph


def test_the_pill_glyphs_are_drawn_not_typed():
    """U+2295 and U+00D7 render with whatever font the host falls back to."""
    body = _function_bodies(CONTENT_JS, r"createTrigger")["createTrigger"]
    assert "${PILL_GLYPH_SVG}" in body and "${PILL_X_SVG}" in body
    assert "<svg" in CONTENT_JS[CONTENT_JS.index("const PILL_GLYPH_SVG"):][:200]


def test_every_pill_state_carries_one_verb():
    """Ready → Insert, stale → Redo, error → Retry: the chip is always the way
    out of the state it is shown in, so nobody has to open the card to get
    unstuck."""
    body = _function_bodies(CONTENT_JS, r"renderPill")["renderPill"]
    assert 'verb = "Retry"' in body and 'verb = "Redo"' in body
    # "Apply" said nothing about what would happen to the text already there.
    assert '"Replace" : "Insert"' in body
    dispatch = _function_bodies(CONTENT_JS, r"pillVerb")["pillVerb"]
    assert "insertDraft()" in dispatch and "redoCard()" in dispatch and "handleEnhance()" in dispatch
    for state in ("stale", "error"):
        assert f'.pm-trigger[data-state="{state}"] .pm-pill-insert' in STYLES_CSS, \
            f"the {state} verb is not coloured for its state"


def test_insert_does_not_advertise_a_navigation_key():
    body = _function_bodies(CONTENT_JS, r"renderPill")["renderPill"]
    assert 'verbEl.textContent = verb;' in body
    assert 'cardKey("Tab")' not in CONTENT_JS


def test_cancel_actually_cancels_the_stream():
    """
    Cancel used to hide the card and let the stream run; when it ended the
    rewrite popped back up as a finished draft.
    """
    close = _function_bodies(CONTENT_JS, r"closeCard")["closeCard"]
    assert 'if (cardState === "streaming" && cancelActiveStream) cancelActiveStream();' in close
    assert "cancelActiveStream = () => finish(() => {});" in _function_bodies(CONTENT_JS, r"runDirectEnhance")["runDirectEnhance"]
    stream = _function_bodies(CONTENT_JS, r"enhancePromptStream")["enhancePromptStream"]
    assert "cancelActiveStream = () => abort.abort();" in stream and "signal: abort.signal" in stream
    assert 'if (cardState !== "streaming") return;' in _function_bodies(CONTENT_JS, r"finalizeStreamingModal")["finalizeStreamingModal"]


def test_the_inserted_receipt_is_not_a_button():
    body = _function_bodies(CONTENT_JS, r"createTrigger")["createTrigger"]
    assert "else if (pillApplied) clearApplied();" in body, \
        "a click on the Inserted pill would spend a model call re-enhancing the rewrite"


def test_a_pill_that_must_move_parks_on_the_composers_corner():
    """Stepping straight up left it hanging in mid-air past the composer's
    edge; stepping up AND in puts it on the corner of the box it writes into,
    flush with the edge the card shares."""
    place = _function_bodies(CONTENT_JS, r"placePill")["placePill"]
    assert "window.innerWidth - r.right" in place and "r.left" in place
    assert "let inset = PILL_MARGIN;" in place


def test_the_card_is_a_sheet_on_the_composer():
    """As wide as the composer (capped), right-aligned to it, directly above
    it. It hangs off the pill only when there is no composer to sit on."""
    body = _function_bodies(CONTENT_JS, r"positionCard")["positionCard"]
    assert 'left = pillDock === "left" ? box.left : box.right - width;' in body
    assert "pillBox.right - width" in body, "no fallback when there is no composer"
    assert "overlapsPill" not in body, "the card yields to the pill again"
    assert 'card.dataset.anchor = onComposer ? "composer" : "pill"' in body


def test_the_pill_steps_aside_for_the_card_not_the_reverse():
    """
    The card is transient and belongs to the composer; the pill's spot is a
    resting preference. A card pushed up above a high pill detached from the
    composer and was squeezed to its minimum height.
    """
    place = _function_bodies(CONTENT_JS, r"placePill")["placePill"]
    assert place.index("positionCard();") < place.index("if (hits(c) || hits(cb)) {"), \
        "the card must be laid out before the pill decides whether to step aside"
    assert "cardEl ? cardEl.getBoundingClientRect() : null" in place
    assert "if (hits(cb)) stepAbove(cb, 8);" in place
    hide = _function_bodies(CONTENT_JS, r"hideCard")["hideCard"]
    assert "pm-card-leaving-up" in hide, "the fold should head toward the pill"


def test_a_displaced_pill_goes_home_before_anywhere_new():
    """
    Home — the bottom corner on its side — is where the eye expects the pill.
    Parking on the card's corner was a third position to learn, and one the
    card could grow over while streaming.
    """
    place = _function_bodies(CONTENT_JS, r"placePill")["placePill"]
    block = place[place.index("if (hits(c) || hits(cb)) {"):]
    assert block.index("bottom = Math.min(maxBottom, PILL_HOME_BOTTOM);") < block.index("if (hits(c)) stepAbove(c, 8);"), \
        "the pill must try home before stepping onto the composer or the card"
    assert "let pillBottom = PILL_HOME_BOTTOM;" in CONTENT_JS


def test_a_dragged_pill_is_never_under_the_card():
    """It is under the user's finger; a handle that vanishes mid-drag gets let
    go of in the wrong place. Placement resolves the collision on release."""
    assert re.search(r"\.pm-trigger\.pm-pill-dragging\s*{[^}]*z-index:\s*var\(--pm-z-drag\)", STYLES_CSS, re.S)
    scale = _z_scale()
    drag = int(re.search(r"--pm-z-drag:\s*(\d+);", STYLES_CSS).group(1))
    assert scale["--pm-z-card"] < drag < scale["--pm-z-overlay"]


def test_the_pill_re_places_when_the_card_grows():
    body = _function_bodies(CONTENT_JS, r"getOrCreateCard")["getOrCreateCard"]
    assert "card._pmResize = new ResizeObserver(() => placePill());" in body
    assert "card._pmResize?.disconnect();" in _function_bodies(CONTENT_JS, r"hideCard")["hideCard"]


def test_the_card_can_be_moved_resized_and_reset():
    setup = _function_bodies(CONTENT_JS, r"setupCardInteractions")["setupCardInteractions"]
    for behavior in ('begin(e, "move")', 'begin(e, "resize")', "setPointerCapture", "saveCardLayout"):
        assert behavior in setup
    assert "pm-card-resize" in CONTENT_JS and ".pm-card-resize" in STYLES_CSS
    assert "pm-card-reset" in CONTENT_JS and ".pm-card-free .pm-card-reset" in STYLES_CSS
    assert "resetCardLayout" in setup
    assert '<button type="button" class="pm-card-resize"' in CONTENT_JS and "ArrowRight" in setup


def test_the_floating_card_is_clamped_and_remembered_per_site():
    position = _function_bodies(CONTENT_JS, r"positionCard")["positionCard"]
    assert "cardLayout?.detached" in position
    assert "clampCardLayout(cardLayout" in position
    assert "rightBound - width" in position
    key = _function_bodies(CONTENT_JS, r"cardLayoutStorageKey")["cardLayoutStorageKey"]
    assert "window.location.hostname" in key


def test_the_pill_reads_the_same_way_in_both_docks():
    """
    Reversing the row when docked left rendered × · Insert · preview · dot.
    It existed to keep the ⊕ against the outer edge, but the ⊕ collapses as
    soon as the pill is open, so it bought nothing and cost the reading order.
    """
    assert "flex-direction: row-reverse" not in STYLES_CSS
    assert '.pm-trigger.pm-pill-open[data-dock="left"]' not in STYLES_CSS, \
        "a mirrored padding rule survives the removal of the mirrored row"


def test_a_cleared_offset_is_auto_not_empty_string():
    """
    style.right = "" only un-shadows the stylesheet, and .pm-trigger carries
    right:16px there. Docked left that left BOTH offsets live and stretched the
    auto-width fixed box across the viewport — a 420px bar instead of a pill.
    """
    for fn in ("placePill", "setupPillDrag"):
        body = _function_bodies(CONTENT_JS, fn)[fn]
        assert 'style.right = ""' not in body and 'style.left = ""' not in body, \
            f"{fn} clears an offset with \"\", which the stylesheet then wins"
    place = _function_bodies(CONTENT_JS, "placePill")["placePill"]
    assert 'inset + "px" : "auto"' in place


# ── an orphaned content script goes quiet, once ───────────────────────────
# Chrome keeps a page's content script alive after the extension is reloaded
# or auto-updated, with a dead chrome.* handle. Every storage call then throws
# "Extension context invalidated" as an uncaught rejection, on every event.


def test_storage_is_never_called_directly():
    """One place that can throw, not twenty."""
    body = CONTENT_JS
    for fn in ("storageGet", "storageSet"):
        assert f"function {fn}(" in body
    assert body.count("chrome.storage.local.get(") == 1
    assert body.count("chrome.storage.local.set(") == 1
    for fn in ("storageGet", "storageSet"):
        assert "extensionAlive()" in _function_bodies(body, fn)[fn]


def test_an_orphaned_script_says_so_and_stops_polling():
    body = _function_bodies(CONTENT_JS, r"onOrphaned")["onOrphaned"]
    assert "if (orphaned) return;" in body, "the reload toast would fire on every event"
    assert "clearInterval(navigationPoll)" in body
    assert "pm-reload-notice" in body
    assert "Reload this tab" in body
    assert "console.warn(" not in body
    nav = _function_bodies(CONTENT_JS, r"watchNavigation")["watchNavigation"]
    assert "navigationPoll = setInterval(check" in nav
    handle = _function_bodies(CONTENT_JS, r"handleEnhance")["handleEnhance"]
    assert "!extensionAlive()" in handle, "the trigger should explain itself, not fail silently"
    init = _function_bodies(CONTENT_JS, r"init")["init"]
    assert "if (orphaned || !extensionAlive())" in init


def test_update_does_not_reinject_into_tabs_with_old_scripts():
    update = BACKGROUND_JS.split('if (reason === "update") {', 1)[1].split('if (reason !== "install")', 1)[0]
    assert "activateExistingTabs()" not in update


# ── a finished draft stays finished ────────────────────────────────────────
# closeCard() hides the card (setExpanded: a read, then a write) and then
# clears the draft. Unordered, the write landed after the clear and put the
# draft back, so every Insert and Discard reappeared on the next page load.

def test_draft_storage_operations_run_one_at_a_time():
    store = CONTENT_JS[CONTENT_JS.index("const draftStore = {"):CONTENT_JS.index("// UI: THE PILL")]
    assert "_serial(fn)" in store
    for method in ("load()", "save(draft)", "clear()", "setExpanded(expanded)"):
        body = store[store.index("  " + method):]
        assert body[:120].count("this._serial(") == 1, f"draftStore.{method} bypasses the queue"


def test_the_popup_shows_the_manifest_version():
    """The popup's label was typed into the HTML and stayed at 4.4 while the
    manifest moved on; it now reads chrome.runtime.getManifest()."""
    import json
    popup_js = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")
    popup_html = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
    assert 'chrome.runtime.getManifest().version' in popup_js
    version = json.loads(MANIFEST)["version"]
    assert f'id="popup-version">v{version}<' in popup_html, "the fallback label disagrees with the manifest"


# ── typing is watched, not listened for ───────────────────────────────────
# ProseMirror (ChatGPT, Claude) inserts typed characters itself when the box
# was focused from code, as those sites do on load and as Insert does, and
# then no input event fires. // never opened there, and its Enter sent the
# message. scripts/check_editors.py exercises the real editors.

def test_the_chat_box_is_watched_by_a_mutation_observer():
    watch = _function_bodies(CONTENT_JS, r"watchComposer")["watchComposer"]
    assert "new MutationObserver(onComposerChanged)" in watch
    assert "characterData: true" in watch and "subtree: true" in watch
    changed = _function_bodies(CONTENT_JS, r"onComposerChanged")["onComposerChanged"]
    for reaction in ("checkSlash()", "refreshCardStaleness()", "positionRail()"):
        assert reaction in changed, f"a text change no longer reaches {reaction}"


def test_the_caret_moving_is_watched_too():
    setup = _function_bodies(CONTENT_JS, r"setupLibraryListeners")["setupLibraryListeners"]
    assert 'addEventListener("selectionchange"' in setup
    assert 'addEventListener("focusin", watchComposer, true)' in setup
    assert "watchComposer()" in _function_bodies(CONTENT_JS, r"onNavigated")["onNavigated"]


def test_a_slash_choice_reads_the_caret_again():
    for fn in ("slashInsert", "slashAttach"):
        body = _function_bodies(CONTENT_JS, fn)[fn]
        assert "refreshSlashToken(slash)" in body, f"{fn} trusts a text node noted when the menu opened"


def test_the_card_folds_when_the_slash_menu_opens():
    body = _function_bodies(CONTENT_JS, r"renderSlash")["renderSlash"]
    assert "if (cardExpanded) hideCard();" in body


def test_the_chat_box_is_cleared_through_the_editor():
    """Lexical reverted execCommand's delete and the insert appended after
    the old text; the editor is now asked first, after it has seen the
    selection."""
    body = _function_bodies(CONTENT_JS, r"clearComposer")["clearComposer"]
    assert body.index("await nextFrame()") < body.index('inputType: "deleteContentBackward"') < body.index('execCommand("delete"')
    assert "await clearComposer(el)" in _function_bodies(CONTENT_JS, r"applyToInput")["applyToInput"]


# ── Tester feedback, 2026-09-24 ──────────────────────────────────────────

POPUP_HTML = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
LIVE_POLICY = "https://prompt-engineering-skeleton-seven.vercel.app/privacy"


def test_the_card_keeps_the_names_of_the_saved_prompts_it_used():
    """runBackendEnhance copied only the counts, so the card could never say
    which saved prompts shaped a rewrite."""
    body = _function_bodies(CONTENT_JS, r"runBackendEnhance")["runBackendEnhance"]
    assert "context_details: metadata.context_details" in body
    used = _function_bodies(CONTENT_JS, r"cardUsedHtml")["cardUsedHtml"]
    assert "selected_prompts" in used and "auto_matched_prompts" in used and "data-pm-drop" in used


def test_a_dropped_saved_prompt_is_sent_as_excluded():
    stream = _function_bodies(CONTENT_JS, r"enhancePromptStream")["enhancePromptStream"]
    assert "body.excluded_prompt_ids = inputMetadata.excludedIds" in stream
    rerun = _function_bodies(CONTENT_JS, r"rerunWithout")["rerunWithout"]
    assert "rerunDraft(" in rerun
    styles = _function_bodies(CONTENT_JS, r"rerunInStyle")["rerunInStyle"]
    assert "cardResult.excluded" in styles, "a dropped prompt must stay dropped in another style"


def test_improving_a_saved_prompt_never_matches_it_against_itself():
    body = _function_bodies(CONTENT_JS, r"improveSavedPrompt")["improveSavedPrompt"]
    assert "excludedIds: [p.id]" in body
    rerun = _function_bodies(CONTENT_JS, r"rerunDraft")["rerunDraft"]
    assert "cardSubject ? [cardSubject.id]" in rerun


def test_an_improve_draft_ignores_the_chat_box():
    stale = _function_bodies(CONTENT_JS, r"isStaleAgainstComposer")["isStaleAgainstComposer"]
    assert "cardSubject" in stale
    accept = _function_bodies(CONTENT_JS, r"acceptCard")["acceptCard"]
    assert accept.index("acceptImprovement()") < accept.index("applyOrFallback")
    improve = _function_bodies(CONTENT_JS, r"acceptImprovement")["acceptImprovement"]
    assert "updateSavedPrompt(subject.id" in improve and "Undo" in improve
    assert "applyOrFallback" not in improve, "updating a saved prompt must not write into the chat box"


def test_prompt_tracking_starts_off():
    """The privacy policy, the first-run notice and the popup all say so."""
    assert "let promptTrackingEnabled = false;" in CONTENT_JS
    assert "result.pm_tracking === true" in CONTENT_JS
    assert "pm_tracking !== false" not in CONTENT_JS


def test_privacy_links_open_the_live_policy():
    for name, src in (("content.js", CONTENT_JS), ("popup.html", POPUP_HTML)):
        assert LIVE_POLICY in src, name
        assert "blob/main/website/privacy.html" not in src, f"{name} links to the GitHub source"


def test_the_card_has_no_layout_button_and_dragging_does_not_need_one():
    assert "pm-card-layout-toggle" not in CONTENT_JS and "pm-card-layout-toggle" not in STYLES_CSS
    body = _function_bodies(CONTENT_JS, r"setupCardInteractions")["setupCardInteractions"]
    assert "if (!head || !grip) return;" in body
    assert 'grip.setAttribute("aria-expanded"' in body


def test_the_library_tabs_are_saved_and_history():
    head = _function_bodies(CONTENT_JS, r"libHeadHtml")["libHeadHtml"]
    assert ">History</button>" in head and ">Recent</button>" not in head


# ── First run: the setup page, the setup modal and the tips ──────────────

POPUP_JS = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")
BACKGROUND_JS = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")


def test_the_setup_page_has_three_screens_chosen_by_state():
    for screen in ("screen-welcome", "screen-setup", "screen-ready"):
        assert f'id="{screen}"' in POPUP_HTML
    body = _function_bodies(POPUP_JS, r"screenFor")["screenFor"]
    assert '"welcome"' in body and '"setup"' in body and '"ready"' in body


def test_the_ready_screen_says_what_to_do_next():
    """People finished setup and did not know the plus button existed."""
    for site in ("https://chatgpt.com/", "https://claude.ai/new", "https://gemini.google.com/app",
                 "https://www.perplexity.ai/", "https://grok.com/"):
        assert f'href="{site}"' in POPUP_HTML
    assert "You're ready. Try it now:" in POPUP_JS


def test_the_setup_page_draws_nothing_from_the_network():
    assert "fonts.googleapis.com" not in POPUP_HTML


def test_the_setup_modal_does_not_render_its_templates_whitespace():
    rule = STYLES_CSS[STYLES_CSS.index(".pm-modal-body {"):]
    rule = rule[:rule.index("}")]
    assert "pre-wrap" not in rule, "HTML modals rendered every newline and indent as blank space"
    assert ".pm-modal-body.pm-modal-text" in STYLES_CSS and 'class="pm-modal-body pm-modal-text"' in CONTENT_JS


def test_the_chat_page_opens_setup_at_the_right_step():
    assert 'openSettings("key")' in CONTENT_JS and 'openSettings("signin")' in CONTENT_JS
    assert "popup.html?onboarding=1#${msg.section}" in BACKGROUND_JS


def test_tips_never_promise_a_shortcut_chrome_did_not_assign():
    assert 'case "PM_GET_SHORTCUT"' in BACKGROUND_JS
    body = _function_bodies(CONTENT_JS, r"orShortcut")["orShortcut"]
    assert 'assignedShortcut ? ' in body and ': ""' in body


def test_tips_are_one_at_a_time_and_stay_out_of_the_way():
    allowed = _function_bodies(CONTENT_JS, r"tipAllowed")["tipAllowed"]
    for guard in ("!tips.off", "!tips.seen[id]", "TIP_MAX_SHOWS", "!cardExpanded", "!panelOpen", "!overlayHasInput()"):
        assert guard in allowed, guard
    show = _function_bodies(CONTENT_JS, r"showTip")["showTip"]
    assert "hideTip()" in show and ".focus(" not in show, "a tip must never take focus"


def test_tips_hear_typing_in_a_textarea_composer():
    """A <textarea> changes its value, not its DOM: the MutationObserver is deaf to it."""
    listeners = _function_bodies(CONTENT_JS, r"setupLibraryListeners")["setupLibraryListeners"]
    assert "tipsOnComposerChanged()" in listeners
