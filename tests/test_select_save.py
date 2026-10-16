"""Select text on a chat page and save it as context."""
import re
from pathlib import Path

CONTENT = (Path(__file__).resolve().parent.parent / "extension" / "content.js").read_text(encoding="utf-8")
PRIVACY = (Path(__file__).resolve().parent.parent / "website" / "privacy.html").read_text(encoding="utf-8")


def _js(name):
    m = re.search(rf"^(?:async )?function {name}\(", CONTENT, re.M)
    assert m, name
    i = re.compile(r"\)\s*\{").search(CONTENT, m.end()).end() - 1
    depth = 0
    for j in range(i, len(CONTENT)):
        depth += {"{": 1, "}": -1}.get(CONTENT[j], 0)
        if depth == 0:
            return CONTENT[i:j + 1]


def test_not_offered_in_the_chat_box_or_our_own_ui():
    check = _js("checkSelection")
    assert "composer.contains(node)" in check and "closest?.(\"[id^='pm-']\")" in check
    assert "SELECT_MIN_CHARS" in check and "SELECT_MAX_CHARS" in check


def test_saving_needs_an_account_and_sends_only_on_press():
    save = _js("saveSelection")
    assert save.index("if (!libSignedIn)") < save.index("createSavedPrompt(")
    assert "undoSave(id)" in save, "a save can be undone"
    assert "saveSelection()" in _js("selectSaveButton"), "only the button saves"


def test_it_has_an_off_switch_and_the_policy_says_so():
    assert 'row("pm-select-save-toggle"' in CONTENT
    assert "Save as context" in PRIVACY
