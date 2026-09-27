"""
The background quality judge must never spend the shared provider pool.

c0c00ba added an LLM judge that scores every rewrite after the fact. It called
providers.chat() with no key, so it fell through to the shared pool — two
shared calls per rewrite instead of one, against an org-wide free tier, and a
BYOK user's evaluation billed to the shared key while their rewrite went to
their own. The judge's call is also uncounted: the daily limit reads the
enhancement log, not this.

Nobody waits on a score, and the judge already has a heuristic to fall back
on, so the rule is simple: its own key or nothing.
"""
import pytest

from backend.core.config import settings
from backend.services import providers
from backend.routers import user_analytics


ORIGINAL = "make my code better"
ENHANCED = "Review this Python module for correctness and readability, and explain each change."


@pytest.fixture
def eval_key(monkeypatch):
    monkeypatch.setattr(settings, "PROMPT_EVAL_BYOK_KEY", "gsk_test_evaluation_key")
    monkeypatch.setattr(settings, "PROMPT_EVAL_PROVIDER", "groq")


def test_the_judge_sends_its_own_key_and_refuses_the_shared_pool(monkeypatch, eval_key):
    seen = {}

    def fake_chat(**kwargs):
        seen.update(kwargs)
        return {"content": '{"original_score": 40, "enhanced_score": 85}',
                "model": "judge-model", "provider": "groq", "byok": True,
                "usage": {}, "attempts": [], "truncated": False}

    monkeypatch.setattr(user_analytics.providers, "chat", fake_chat)
    user_analytics.judge_prompt_improvement(ORIGINAL, ENHANCED)

    assert seen["user_key"] == "gsk_test_evaluation_key"
    assert seen["user_provider"] == "groq"
    assert seen["allow_shared_fallback"] is False, (
        "an exhausted evaluation key must not roll over onto the shared pool"
    )


def test_no_evaluation_key_means_no_llm_call_at_all(monkeypatch):
    """
    Recorded rather than raised: judge_prompt_improvement() catches every
    exception and falls back to the heuristic, so an assert inside the stub
    would be swallowed and the test would pass on the very code it is meant
    to catch.
    """
    monkeypatch.setattr(settings, "PROMPT_EVAL_BYOK_KEY", "")
    calls = []
    monkeypatch.setattr(
        user_analytics.providers, "chat",
        lambda **kwargs: calls.append(kwargs) or {"content": "{}", "model": "m",
                                                  "provider": "p", "byok": False,
                                                  "usage": {}, "attempts": [],
                                                  "truncated": False},
    )

    result = user_analytics.judge_prompt_improvement(ORIGINAL, ENHANCED)
    assert calls == [], "the judge called an LLM with no evaluation key configured"
    assert result["enhanced_score"] > 0, "it still scores, from the heuristic"


def test_a_spent_evaluation_key_degrades_to_the_heuristic(monkeypatch, eval_key):
    """Not to the shared pool, and not to an error — the score just gets cheaper."""
    def rate_limited(**kwargs):
        raise providers.NoProviderAvailable([("groq/judge", "HTTP 429 (rate_limit)")])

    monkeypatch.setattr(user_analytics.providers, "chat", rate_limited)

    result = user_analytics.judge_prompt_improvement(ORIGINAL, ENHANCED)
    assert result["enhanced_score"] > 0
    assert result.get("evaluator", "heuristic") != "judge-model"


def test_the_chain_drops_the_shared_pool_when_fallback_is_refused():
    """
    The unit underneath: _resolve_chain appends DEFAULT_CHAIN unconditionally,
    which is why passing a key alone was never enough to stay off the pool.
    """
    with_net = providers._resolve_chain("groq", "gsk_explicit", None)
    without_net = providers._resolve_chain("groq", "gsk_explicit", None,
                                           allow_shared_fallback=False)

    assert any(key is None for _, key in with_net), "the net is there by default"
    assert without_net, "the explicit key's own rungs survive"
    assert all(key == "gsk_explicit" for _, key in without_net), (
        "no rung may run on a shared key"
    )


def test_refusing_the_fallback_without_a_key_still_yields_the_shared_chain():
    """
    A caller that refuses the net but supplies no key would otherwise get an
    empty chain and an immediate NoProviderAvailable. The flag is there to stop
    a key rolling over, not to disable the provider layer.
    """
    chain = providers._resolve_chain(None, None, None, allow_shared_fallback=False)
    assert chain, "no explicit key means there is nothing to protect"
    assert all(key is None for _, key in chain)
