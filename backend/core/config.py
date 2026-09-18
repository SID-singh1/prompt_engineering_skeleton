import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from ..core.logger import logger


env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)


class Settings:
    # Environment: "development" or "production"
    ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

    # API Keys — Groq is the default provider; the others are only needed if
    # you want a server-side fallback beyond Groq. Users supplying their own
    # key (BYOK) do not require any of these to be set.
    GROQ_API_KEY = os.getenv("GROQ_API_KEY")
    GROQ_API_KEY_2 = os.getenv("GROQ_API_KEY_2")
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
    OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
    MONGO_URI = os.getenv("MONGO_URI")
    # No port is appended here. An earlier version rewrote a portless
    # *.cloud.qdrant.io URL to :6333, on the theory that the missing port was
    # why the cluster was unreachable. It was not: Qdrant Cloud serves REST on
    # 443 for both reads and writes (verified against a live cluster), the old
    # cluster was simply gone, and silently rewriting an operator's configured
    # endpoint would break any deployment reachable only on 443.
    QDRANT_URL = os.getenv("QDRANT_URL", ":memory:").strip()

    # Requests to the vector store are on the critical path of every /enhance,
    # so a hung cluster must fail fast rather than hold the request open.
    QDRANT_TIMEOUT = float(os.getenv("QDRANT_TIMEOUT", "8"))

    # How long to wait before retrying a vector store that failed to connect.
    # Without this the choice is between retrying on every single request
    # (hammering a struggling cluster) and never retrying at all (a transient
    # blip disables memory features until the next deploy).
    QDRANT_RETRY_SECONDS = float(os.getenv("QDRANT_RETRY_SECONDS", "30"))
    QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
    SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
    
    # Auth
    GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_REDIRECT_URI = os.getenv(
        "GOOGLE_REDIRECT_URI",
        "http://localhost:8000/auth/google/callback"
    )
    JWT_SECRET = os.getenv("JWT_SECRET", "unsafedefaultsecret")
    ALGORITHM = "HS256"
    
    # Origins the extension's content script runs on. Must stay in sync with
    # content_scripts.matches in extension/manifest.json — tests/
    # test_extension_static.py asserts they do not drift apart.
    EXTENSION_ORIGINS = [
        "https://chatgpt.com",
        "https://gemini.google.com",
        "https://claude.ai",
        "https://www.perplexity.ai",
        "https://grok.com",
        "https://x.com",
    ]

    # CORS — comma-separated origins allowed in production
    # In development, all origins ("*") are allowed automatically
    FRONTEND_ORIGINS = os.getenv("FRONTEND_ORIGINS", "").split(",") if os.getenv("FRONTEND_ORIGINS") else []

    # Origins that may host the private builder dashboard when it is deployed
    # separately from the API. These are added to production CORS, but never
    # grant access without the independent builder dashboard key.
    BUILDER_DASHBOARD_ORIGINS = (
        os.getenv("BUILDER_DASHBOARD_ORIGINS", "").split(",")
        if os.getenv("BUILDER_DASHBOARD_ORIGINS") else []
    )
    
    # Production backend URL (used by extension config)
    PROD_URL = os.getenv("PROD_URL", "https://siddhm11-prompt-engine.hf.space")

    # Private builder dashboard. The dashboard page is intentionally not linked
    # from the public site; the API is disabled until this high-entropy secret
    # is configured and never accepts it in a query string.
    BUILDER_DASHBOARD_KEY = os.getenv("BUILDER_DASHBOARD_KEY", "").strip()

    # Dashboard queries are intentionally bounded. A private page must not be
    # able to read an unbounded prompt-log history into one application worker.
    DASHBOARD_MAX_LOGS = int(os.getenv("DASHBOARD_MAX_LOGS", "50000"))

    # Failure events contain metadata only and are useful for operational
    # review, not permanent archival. Set 0 only with a deliberate retention
    # decision.
    ANALYTICS_EVENT_TTL_DAYS = int(os.getenv("ANALYTICS_EVENT_TTL_DAYS", "90"))
    
    # Constants
    EMBEDDING_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    COLLECTION_NAME = "prompt_memory"

    # Calibrated on evals/context_retrieval_cases.json. Saved prompts are
    # concrete user-authored facts and can use a slightly stricter gate;
    # passive patterns are phrased less like the current query and otherwise
    # disappear almost entirely at the former 0.50 threshold.
    SAVED_CONTEXT_MIN_SCORE = float(os.getenv("SAVED_CONTEXT_MIN_SCORE", "0.24"))
    PASSIVE_CONTEXT_MIN_SCORE = float(os.getenv("PASSIVE_CONTEXT_MIN_SCORE", "0.20"))

    # Rate Limiting. Enforced per authenticated user by core.ratelimit, not by
    # IP: the Space sits behind a proxy, so every request shares one source
    # address and an IP-keyed limiter would throttle the whole user base as one.
    RATE_LIMIT_ENHANCE = os.getenv("RATE_LIMIT_ENHANCE", "30/minute")
    RATE_LIMIT_VOICE = os.getenv("RATE_LIMIT_VOICE", "10/minute")

    # Largest request body accepted, before auth runs. A 20 MB unauthenticated
    # POST was previously parsed in full and only then rejected with a 401.
    MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(2 * 1024 * 1024)))

    # Voice uploads are audio and legitimately exceed the general cap: ~2.3 MB
    # for ten minutes of 32 kbps opus, and half that duration at 64 kbps. A flat
    # 2 MB limit would have started rejecting real recordings with an opaque 413.
    MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))

    # Routes allowed the larger body. Prefix match.
    LARGE_BODY_ROUTES = ("/voice-enhance",)

    # Prompt-log retention, in days. 0 (the default) disables expiry.
    #
    # Deliberately OFF by default. A TTL index is applied by the database the
    # moment it is created, so shipping a 90-day default would have silently
    # and irreversibly deleted every prompt log older than 90 days on the first
    # boot after deploy — this project has logs going back to January. Enabling
    # retention is a decision with data loss attached, so it has to be made
    # explicitly, not inherited from a default.
    #
    # Set PROMPT_LOG_TTL_DAYS=90 once you have decided that is what you want.
    PROMPT_LOG_TTL_DAYS = int(os.getenv("PROMPT_LOG_TTL_DAYS", "0"))

    # Expose /docs and /openapi.json. Off in production: they enumerate every
    # route on a publicly reachable backend.
    ENABLE_DOCS = os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes")

    # Model selection lives in services/providers.py as an ordered fallback
    # chain, not here. Pinning a single model id in config is what caused the
    # 2026-08-16 outage: Groq decommissioned llama-3.3-70b-versatile and every
    # request began failing with no fallback. Override the head of the chain
    # here only if you need to force a specific model.
    MODEL_OVERRIDE = os.getenv("MODEL_OVERRIDE", "").strip() or None

    # Daily enhancement limits.
    #
    # The shared server key is a genuinely scarce resource: Groq's free tier is
    # 1,000 requests/day and 8,000 tokens/minute per ORGANISATION, and this app
    # spends ~2,000 tokens per enhancement. That is ~4 enhancements per minute
    # and ~100 per day for the entire user base combined — so the shared-key
    # allowance is rationed tightly and users are steered toward BYOK, where
    # the same 1,000 requests/day belong to them alone.
    SHARED_KEY_DAILY_LIMIT = int(os.getenv("SHARED_KEY_DAILY_LIMIT", "15"))
    BYOK_DAILY_LIMIT = int(os.getenv("BYOK_DAILY_LIMIT", "1000"))

    TIER_LIMITS = {
        "free":       int(os.getenv("FREE_TIER_LIMIT", str(SHARED_KEY_DAILY_LIMIT))),
        "byok":       int(os.getenv("BYOK_DAILY_LIMIT", "1000")),
        "pro":        int(os.getenv("PRO_TIER_LIMIT", "200")),
        "enterprise": int(os.getenv("ENTERPRISE_TIER_LIMIT", "9999")),
    }

    # Stripe (for future payment integration)
    STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
    STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    @property
    def is_production(self) -> bool:
        """
        Whitespace- and quote-tolerant on purpose.

        This was `self.ENVIRONMENT.lower() == "production"`. A value of
        "production " — a trailing space picked up from a hosting panel's env
        editor — evaluated to False and silently reverted CORS to allow-all and
        re-exposed /docs, with nothing anywhere reporting that production mode
        was off. A config typo should not quietly disable every hardening
        measure, so the comparison is now forgiving and the current environment
        is reported by the health endpoint.
        """
        return (self.ENVIRONMENT or "").strip().strip("\"'").lower() == "production"

    def validate(self):
        """Run safety checks. Call on startup."""
        if self.is_production and self.JWT_SECRET == "unsafedefaultsecret":
            logger.info("\n" + "=" * 60)
            logger.error("❌ FATAL: JWT_SECRET is set to the default value!")
            logger.info("   In production, you MUST set a secure JWT_SECRET.")
            logger.info("   Set it in your .env file or environment variables.")
            logger.info("=" * 60 + "\n")
            sys.exit(1)

        # The extension's content script calls /enhance, /track, /saved-prompts
        # and friends directly from the chat page, so those requests carry the
        # CHAT SITE as their Origin — not the extension id. In production
        # cors_origins is exactly FRONTEND_ORIGINS, so any of these missing
        # means every enhancement from that platform is CORS-blocked, which
        # presents as "the product silently stopped working" rather than as a
        # configuration error. Popup and service-worker calls are unaffected:
        # those get extension privileges via host_permissions and bypass CORS.
        if self.is_production:
            configured = {o.strip().rstrip("/") for o in self.FRONTEND_ORIGINS if o.strip()}
            missing = [o for o in self.EXTENSION_ORIGINS if o not in configured]
            if not configured:
                logger.info("\n" + "=" * 60)
                logger.warning("⚠️  FRONTEND_ORIGINS is empty in production.")
                logger.info("   CORS will block EVERY request the extension makes from a chat page.")
                logger.info(f"   FRONTEND_ORIGINS={','.join(self.EXTENSION_ORIGINS)}")
                logger.info("=" * 60 + "\n")
            elif missing:
                logger.info("\n" + "=" * 60)
                logger.warning("⚠️  FRONTEND_ORIGINS is missing platforms the extension runs on.")
                logger.info("   Enhancement will fail with a CORS error on:")
                for o in missing:
                    logger.info(f"     - {o}")
                logger.info(f"   Full list: FRONTEND_ORIGINS={','.join(self.EXTENSION_ORIGINS)}")
                logger.info("=" * 60 + "\n")

    @property
    def cors_origins(self) -> list:
        """Returns CORS origins based on environment."""
        if not self.is_production:
            return ["*"]
        origins = []
        for raw in [*self.FRONTEND_ORIGINS, *self.BUILDER_DASHBOARD_ORIGINS]:
            origin = raw.strip()
            if origin and origin not in origins:
                origins.append(origin)
        return origins

    @property
    def cors_allow_credentials(self) -> bool:
        """
        Always False. Auth travels in an Authorization header, never a cookie,
        so credentialed CORS buys nothing — and pairing it with allow_origins
        ["*"] made Starlette reflect whichever Origin asked, which is the one
        combination the spec forbids.
        """
        return False

settings = Settings()
