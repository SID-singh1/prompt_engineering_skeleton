"""
Markdown emphasis must not reach the composer.

The rewrite is pasted into a plain chat box, not a markdown renderer, so
`**Ladder Operators**` arrives with the asterisks visible. They carry no
meaning there — they are instructions to a renderer that is not present.
"""

import pytest

from backend.services.providers import strip_markdown_emphasis as strip, sanitize_output


def test_the_reported_case():
    raw = "1.  **Ladder Operators**: Begin by defining the creation operators."
    assert strip(raw) == "1.  Ladder Operators: Begin by defining the creation operators."


@pytest.mark.parametrize("raw,expected", [
    ("**bold**", "bold"),
    ("a **bold** word", "a bold word"),
    ("**two** and **three**", "two and three"),
    ("## Heading\nbody", "Heading\nbody"),
    ("###### deep\nbody", "deep\nbody"),
])
def test_emphasis_removed(raw, expected):
    assert strip(raw) == expected


@pytest.mark.parametrize("raw", [
    # Structure that reads fine as plain text and carries real meaning.
    "- first\n- second",
    "1. one\n2. two",
    # A lone asterisk is ambiguous — multiplication, a footnote marker.
    "compute 2 * 3 and 4 * 5",
    # Dunders are common in prompts about Python. Mangling them is worse than
    # leaving an underscore in, so __underline__ is not handled at all.
    "call __init__ and __repr__ safely",
    "use get_user_id not getUserId",
    # LaTeX carries information and the target chat apps render it.
    r"derive $E_n = \hbar\omega(n + \frac{1}{2})$",
    "plain prose with no markup at all",
])
def test_left_alone(raw):
    assert strip(raw) == raw


def test_code_fences_are_never_touched():
    """The system prompt promises to preserve the user's code exactly, and
    asterisks are meaningful in most languages."""
    raw = "Fix this:\n```python\nx = a ** 2\ny = b ** 3\n```\nand **explain** it"
    out = strip(raw)
    assert "a ** 2" in out and "b ** 3" in out
    assert "**explain**" not in out and "explain it" in out


def test_inline_code_is_never_touched():
    out = strip("The `a ** b` operator, **explained**")
    assert "`a ** b`" in out
    assert "**explained**" not in out


def test_runs_as_part_of_sanitize_output():
    """The stripper has to be wired into the real pipeline, not just exist."""
    assert "**" not in sanitize_output("**Rewrite** this prompt")


def test_empty_and_none_are_survivable():
    assert strip("") == ""
    assert strip(None) is None


def test_unbalanced_asterisks_are_not_mangled():
    assert strip("a ** b") == "a ** b"
    assert strip("**unclosed") == "**unclosed"
