"""
CORS configuration.

The app paired allow_origins=["*"] with allow_credentials=True. Starlette
resolves that by reflecting whichever Origin asked, with credentials permitted
— the one combination the CORS spec forbids. Auth here travels in an
Authorization header, never a cookie, so credentialed CORS was never needed.
"""

import pytest
from backend.core.config import settings


def test_credentials_are_never_allowed():
    assert settings.cors_allow_credentials is False


def test_wildcard_origins_are_not_paired_with_credentials():
    if "*" in settings.cors_origins:
        assert settings.cors_allow_credentials is False


def test_production_uses_an_explicit_allowlist(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "FRONTEND_ORIGINS", ["https://example.com"])
    assert settings.cors_origins == ["https://example.com"]
    assert "*" not in settings.cors_origins


@pytest.mark.parametrize("raw,expected", [
    ("production", True),
    ("production ", True),      # trailing space from an env editor
    (" production", True),
    ("PRODUCTION", True),
    ('"production"', True),     # quotes pasted in with the value
    ("development", False),
    ("", False),
    ("prod", False),            # not an accepted spelling; must stay explicit
])
def test_is_production_tolerates_whitespace_and_quotes(monkeypatch, raw, expected):
    """
    A stray space in this value silently reverted CORS to allow-all and
    re-exposed /docs, with no signal anywhere that hardening was off.
    """
    monkeypatch.setattr(settings, "ENVIRONMENT", raw)
    assert settings.is_production is expected


def test_production_mode_actually_narrows_cors(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production ")
    monkeypatch.setattr(settings, "FRONTEND_ORIGINS", ["https://chatgpt.com"])
    assert settings.cors_origins == ["https://chatgpt.com"]
    assert "*" not in settings.cors_origins


def test_private_dashboard_origin_is_added_without_opening_production_cors(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "FRONTEND_ORIGINS", ["https://chatgpt.com"])
    monkeypatch.setattr(settings, "BUILDER_DASHBOARD_ORIGINS", ["https://builder.example"])
    assert settings.cors_origins == ["https://chatgpt.com", "https://builder.example"]
