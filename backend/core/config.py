import os
import sys
from pathlib import Path
from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)


class Settings:
    # Environment: "development" or "production"
    ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

    # API Keys
    GROQ_API_KEY = os.getenv("GROQ_API_KEY")
    GROQ_API_KEY_2 = os.getenv("GROQ_API_KEY_2")
    MONGO_URI = os.getenv("MONGO_URI")
    QDRANT_URL = os.getenv("QDRANT_URL", ":memory:")
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
    
    # CORS — comma-separated origins allowed in production
    # In development, all origins ("*") are allowed automatically
    FRONTEND_ORIGINS = os.getenv("FRONTEND_ORIGINS", "").split(",") if os.getenv("FRONTEND_ORIGINS") else []
    
    # Production backend URL (used by extension config)
    PROD_URL = os.getenv("PROD_URL", "https://siddhm11-prompt-engine.hf.space")
    
    # Constants
    EMBEDDING_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    COLLECTION_NAME = "prompt_memory"

    # Rate Limiting
    RATE_LIMIT_ENHANCE = os.getenv("RATE_LIMIT_ENHANCE", "30/minute")
    RATE_LIMIT_VOICE = os.getenv("RATE_LIMIT_VOICE", "10/minute")

    # Subscription Tiers — model routing
    TIER_MODELS = {
        "free":       os.getenv("FREE_TIER_MODEL", "llama-3.1-8b-instant"),
        "pro":        os.getenv("PRO_TIER_MODEL", "llama-3.3-70b-versatile"),
        "enterprise": os.getenv("ENTERPRISE_TIER_MODEL", "llama-3.3-70b-versatile"),
    }

    # Daily enhancement limits per tier
    TIER_LIMITS = {
        "free":       int(os.getenv("FREE_TIER_LIMIT", "20")),
        "pro":        int(os.getenv("PRO_TIER_LIMIT", "200")),
        "enterprise": int(os.getenv("ENTERPRISE_TIER_LIMIT", "9999")),
    }

    # Stripe (for future payment integration)
    STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
    STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"

    def validate(self):
        """Run safety checks. Call on startup."""
        if self.is_production and self.JWT_SECRET == "unsafedefaultsecret":
            print("\n" + "=" * 60)
            print("❌ FATAL: JWT_SECRET is set to the default value!")
            print("   In production, you MUST set a secure JWT_SECRET.")
            print("   Set it in your .env file or environment variables.")
            print("=" * 60 + "\n")
            sys.exit(1)

        if self.is_production and not self.FRONTEND_ORIGINS:
            print("⚠️  WARNING: No FRONTEND_ORIGINS set in production. CORS will block all cross-origin requests.")
            print("   Set FRONTEND_ORIGINS in .env (comma-separated), e.g.:")
            print("   FRONTEND_ORIGINS=https://yoursite.com,chrome-extension://your-extension-id")

    @property
    def cors_origins(self) -> list:
        """Returns CORS origins based on environment."""
        if not self.is_production:
            return ["*"]
        return [o.strip() for o in self.FRONTEND_ORIGINS if o.strip()]

settings = Settings()
