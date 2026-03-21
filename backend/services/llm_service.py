
from functools import lru_cache
from groq import Groq
from sentence_transformers import SentenceTransformer
from ..core.config import settings
import time

# Global singletons
_embedding_model = None
_embedding_unavailable = False

# ══════════════════════════════════════════════════════════════
# GROQ CLIENT POOL — Key Rotation + Automatic 429 Fallback
# ══════════════════════════════════════════════════════════════

class GroqClientPool:
    """
    Manages multiple Groq API keys with automatic rotation.
    
    On 429 (rate limit), it:
      1. Marks the current key as cooldown
      2. Switches to the next available key
      3. Retries the request
    
    This is transparent to callers — they just call get_groq_client().
    """

    def __init__(self):
        self._clients = []
        self._key_labels = []
        self._current_index = 0
        self._cooldowns = {}  # key_index -> cooldown_until timestamp

        # Load all available keys
        keys = []
        if settings.GROQ_API_KEY:
            keys.append(("GROQ_API_KEY", settings.GROQ_API_KEY.strip()))
        if settings.GROQ_API_KEY_2:
            keys.append(("GROQ_API_KEY_2", settings.GROQ_API_KEY_2.strip()))

        for label, key in keys:
            try:
                client = Groq(api_key=key)
                self._clients.append(client)
                self._key_labels.append(label)
            except Exception as e:
                print(f"⚠️ Failed to init Groq client with {label}: {e}")

        if self._clients:
            print(f"✅ Groq client pool initialized: {len(self._clients)} key(s) ({', '.join(self._key_labels)})")
        else:
            print("❌ No Groq API keys available!")

    @property
    def available(self):
        return len(self._clients) > 0

    def get_client(self):
        """Get the current active client (rotates on 429)."""
        if not self._clients:
            return None

        now = time.time()

        # Try each key, starting from current index
        for i in range(len(self._clients)):
            idx = (self._current_index + i) % len(self._clients)

            # Skip keys still in cooldown
            cooldown_until = self._cooldowns.get(idx, 0)
            if now < cooldown_until:
                continue

            self._current_index = idx
            return self._clients[idx]

        # All keys are in cooldown — return the one with shortest cooldown
        soonest = min(self._cooldowns, key=self._cooldowns.get)
        self._current_index = soonest
        return self._clients[soonest]

    def mark_rate_limited(self, retry_after_seconds=60):
        """Mark the current key as rate-limited. Pool auto-rotates to next."""
        idx = self._current_index
        cooldown_until = time.time() + retry_after_seconds
        self._cooldowns[idx] = cooldown_until
        label = self._key_labels[idx]

        # Rotate to next
        next_idx = (idx + 1) % len(self._clients)
        next_label = self._key_labels[next_idx]
        self._current_index = next_idx

        print(f"🔄 Key rotation: {label} rate-limited → switching to {next_label} (cooldown {retry_after_seconds}s)")

    def get_status(self):
        """Return pool status for health checks."""
        now = time.time()
        return {
            "total_keys": len(self._clients),
            "active_key": self._key_labels[self._current_index] if self._clients else None,
            "keys": [
                {
                    "label": self._key_labels[i],
                    "status": "cooldown" if now < self._cooldowns.get(i, 0) else "active",
                    "cooldown_remaining": max(0, round(self._cooldowns.get(i, 0) - now))
                }
                for i in range(len(self._clients))
            ]
        }


# Global pool instance
_pool = GroqClientPool()


def get_groq_client():
    """Get the current Groq client from the pool. Transparent key rotation."""
    return _pool.get_client()


def mark_groq_rate_limited(retry_after=60):
    """Call this when a 429 is received — pool auto-rotates to next key."""
    _pool.mark_rate_limited(retry_after)


def get_groq_pool_status():
    """Get the status of all keys in the pool."""
    return _pool.get_status()


# ══════════════════════════════════════════════════════════════
# EMBEDDING MODEL (unchanged)
# ══════════════════════════════════════════════════════════════

def preload_embedding_model():
    """Eagerly load the embedding model on startup (eliminates first-request cold start)."""
    global _embedding_model, _embedding_unavailable
    if _embedding_model is not None or _embedding_unavailable:
        return
    try:
        print("⏳ Pre-loading embedding model on startup...")
        try:
            _embedding_model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME, backend="onnx")
            print("✅ Embedding model pre-loaded (ONNX backend)")
        except Exception:
            _embedding_model = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)
            print("✅ Embedding model pre-loaded (default backend)")
    except Exception as e:
        _embedding_unavailable = True
        print(f"⚠️ Embedding unavailable: {e}")

def _encode_text(text: str):
    """Internal encoder — separated so we can cache the tuple-based wrapper."""
    global _embedding_model, _embedding_unavailable

    if _embedding_unavailable:
        return None

    if _embedding_model is None:
        preload_embedding_model()
        if _embedding_model is None:
            return None

    return _embedding_model.encode(text, convert_to_numpy=True).tolist()

# LRU cache: avoids re-encoding the same prompt text multiple times
@lru_cache(maxsize=256)
def get_embedding(text: str):
    """Converts text to 384-dim vector using multilingual MiniLM-L12. Cached for repeated calls."""
    return _encode_text(text)
