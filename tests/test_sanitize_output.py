r"""
Regression tests for providers.sanitize_output().

The Harmony strip used to be `<\|...\|>[^\n]*` — greedy to end of line. A leak
with no newline before the real content therefore deleted the whole response,
and the caller reported "empty completion" and fell through the entire model
chain for what was actually a good answer.
"""

import pytest
from backend.services.providers import sanitize_output


def test_single_line_harmony_leak_keeps_the_content():
    """The exact shape that used to return an empty string."""
    raw = "<|start|>assistant<|message|>Write a Python function that sorts a list."
    assert sanitize_output(raw) == "Write a Python function that sorts a list."


def test_multiline_harmony_leak_still_stripped():
    raw = "<|start|>assistant<|message|>\nWrite a Python function that sorts a list."
    assert sanitize_output(raw) == "Write a Python function that sorts a list."


def test_channel_header_leak():
    raw = "<|channel|>final<|message|>Explain recursion simply."
    assert sanitize_output(raw) == "Explain recursion simply."


@pytest.mark.parametrize("text", [
    "Plain output with no leak at all.",
    "Compare a <|pipe|> literal that appears in the user's own text.",
    "Explain how the |> operator works in F#.",
])
def test_unrelated_text_is_untouched(text):
    assert sanitize_output(text) == text


def test_leading_think_block_removed():
    assert sanitize_output("<think>hmm</think>Real content.") == "Real content."


def test_empty_input():
    assert sanitize_output("") == ""
    assert sanitize_output(None) == ""
