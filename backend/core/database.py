
import time

from pymongo import MongoClient
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, Distance
from .config import settings

# MongoDB
class MongoDB:
    client: MongoClient = None
    db = None
    users_col = None
    prompts_col = None
    saved_prompts_col = None
    feedback_col = None
    analytics_col = None
    
    @classmethod
    def connect(cls):
        try:
            cls.client = MongoClient(
                settings.MONGO_URI or "mongodb://localhost:27017",
                serverSelectionTimeoutMS=3000,
            )
            cls.client.admin.command("ping")
            cls.db = cls.client["prompt_engine_db"]
            cls.users_col = cls.db["users"]
            cls.prompts_col = cls.db["prompt_logs"]
            cls.saved_prompts_col = cls.db["saved_prompts"]
            cls.feedback_col = cls.db["user_feedback"]
            cls.analytics_col = cls.db["analytics_events"]

            # Indexes
            cls.users_col.create_index("user_id", unique=True)
            cls.prompts_col.create_index([("user_id", 1), ("timestamp", -1)])
            # Acceptance resolves an opaque log ID inside one user's history.
            # Keep this non-unique for compatibility with older log documents
            # that have no log_id at all.
            cls.prompts_col.create_index([("user_id", 1), ("log_id", 1)])
            # The private dashboard queries all users inside a time window, so
            # the existing user_id-first index cannot serve it efficiently.
            cls.prompts_col.create_index([("timestamp", -1)])
            cls.saved_prompts_col.create_index("user_id")
            cls.feedback_col.create_index([("user_id", 1), ("timestamp", -1)])
            cls.analytics_col.create_index([("timestamp", -1)])
            cls.analytics_col.create_index([("event", 1), ("timestamp", -1)])

            # get_user_feedback_summary() reads db["prompt_feedback"], which is a
            # DIFFERENT collection from feedback_col (db["user_feedback"]) above.
            # It was never indexed, so every /enhance ran an unindexed scan plus
            # an in-memory sort against it.
            cls.db["prompt_feedback"].create_index([("user_id", 1), ("timestamp", -1)])
            cls.db["prompt_feedback"].create_index([("timestamp", -1)])

            # Retention. Atlas M0 is 512 MB and nothing ever deleted a prompt
            # log, so the cluster filled and then failed writes silently.
            # expireAfterSeconds on a date field lets Mongo do the pruning.
            if settings.PROMPT_LOG_TTL_DAYS > 0:
                _ttl = settings.PROMPT_LOG_TTL_DAYS * 86400
                cls._ensure_ttl(cls.prompts_col, "timestamp", _ttl)
                cls._ensure_ttl(cls.db["prompt_feedback"], "timestamp", _ttl)

            if settings.ANALYTICS_EVENT_TTL_DAYS > 0:
                cls._ensure_ttl(
                    cls.analytics_col,
                    "timestamp",
                    settings.ANALYTICS_EVENT_TTL_DAYS * 86400,
                )

            print("✅ MongoDB Indexes Verified")
            print("✅ MongoDB Connected")
        except Exception as e:
            print(f"⚠️ MongoDB not available ({e}) — using in-memory fallback.")
            # db and client must be cleared too. Leaving them set produced a
            # split brain: feedback writes (which test `MongoDB.db is not None`)
            # kept targeting a dead client while everything else fell back to
            # RAM, so the two halves of a request disagreed about reality.
            cls.client = None
            cls.db = None
            cls.users_col = None
            cls.prompts_col = None
            cls.saved_prompts_col = None
            cls.feedback_col = None
            cls.analytics_col = None

    @staticmethod
    def _ensure_ttl(col, field: str, seconds: int):
        """Create a TTL index, tolerating one that already exists with a different span."""
        try:
            col.create_index(field, expireAfterSeconds=seconds)
        except Exception as e:
            print(f"⚠️ TTL index on {col.name}.{field} skipped: {e}")

# Qdrant
class QdrantDB:
    """
    Vector store access, with the failure modes made survivable.

    Every one of the behaviours below caused a real, months-long outage that was
    invisible from outside: the saved-prompt library appeared to save correctly
    and silently never matched anything, because a dead cluster and an empty
    result set were indistinguishable at every layer.
    """

    client: QdrantClient = None
    _collections_ready = False
    _last_error: str = None
    _last_attempt: float = 0.0
    _connected_at: float = None

    SAVED_COLLECTION = "saved_prompt_vectors"

    # Must match the embedding model's output width. get_embedding() uses
    # paraphrase-multilingual-MiniLM-L12-v2, which is 384-dimensional; a
    # collection built for a different width rejects every upsert.
    VECTOR_SIZE = 384

    @classmethod
    def get_client(cls):
        """
        A client that has actually talked to the cluster, or None.

        Previously this returned any successfully *constructed* client.
        QdrantClient does not dial on construction, so a cluster that was
        deleted, suspended or unreachable still produced a client object and a
        "Connected" log line, and every subsequent operation failed into an
        exception handler that returned an empty list.
        """
        if cls.client is not None and cls._collections_ready:
            return cls.client

        # Back off between attempts: retrying on every request hammers a
        # struggling cluster, never retrying leaves a transient blip permanent.
        now = time.monotonic()
        if cls.client is None and cls._last_attempt and \
                (now - cls._last_attempt) < settings.QDRANT_RETRY_SECONDS:
            return None
        cls._last_attempt = now

        if cls.client is None:
            try:
                candidate = QdrantClient(
                    url=settings.QDRANT_URL,
                    api_key=settings.QDRANT_API_KEY,
                    timeout=settings.QDRANT_TIMEOUT,
                )
                # The connectivity check that was missing. Cheap, and the only
                # thing that distinguishes a live cluster from a dead one.
                candidate.get_collections()
                cls.client = candidate
                cls._last_error = None
                cls._connected_at = time.time()
                print(f"✅ Qdrant connected ({cls._host_only()})")
            except Exception as e:
                cls.client = None
                cls._collections_ready = False
                cls._last_error = f"{type(e).__name__}: {e}"[:200]
                print(f"❌ Qdrant unreachable ({cls._host_only()}): {cls._last_error}")
                print("   Saved-prompt search and passive memory are disabled until it recovers.")
                return None

        if not cls._collections_ready:
            # Only latch when provisioning actually succeeded. This used to be
            # set unconditionally, so one failed startup left the collections
            # uncreated for the life of the process.
            results = [cls._ensure_collection(settings.COLLECTION_NAME),
                       cls._ensure_collection(cls.SAVED_COLLECTION)]
            cls._collections_ready = all(results)
            if not cls._collections_ready:
                print("⚠️ Qdrant collections not ready — will retry on the next call.")

        return cls.client

    @classmethod
    def _host_only(cls) -> str:
        """Host without credentials, for logs."""
        raw = settings.QDRANT_URL or ""
        return raw.split("://")[-1].split("/")[0] or raw

    @classmethod
    def reset(cls):
        """Drop the cached client so the next call reconnects."""
        cls.client = None
        cls._collections_ready = False
        cls._last_attempt = 0.0

    @classmethod
    def _ensure_collection(cls, name: str) -> bool:
        """
        Make sure `name` exists with the right geometry. Returns success.

        Returned None before, and its caller ignored it either way.
        """
        try:
            info = cls.client.get_collection(name)
            size = cls._configured_size(info)
            if size is not None and size != cls.VECTOR_SIZE:
                # Loud on purpose: every upsert would be rejected, and the
                # symptom is once again "search returns nothing".
                cls._last_error = (
                    f"collection '{name}' is {size}-dim, embeddings are "
                    f"{cls.VECTOR_SIZE}-dim"
                )
                print(f"❌ {cls._last_error}. Recreate the collection or change the model.")
                return False
        except Exception:
            try:
                cls.client.create_collection(
                    collection_name=name,
                    vectors_config=VectorParams(size=cls.VECTOR_SIZE, distance=Distance.COSINE),
                )
                print(f"✅ Created Qdrant collection '{name}'")
            except Exception as e:
                cls._last_error = f"create '{name}' failed: {e}"[:200]
                print(f"⚠️ {cls._last_error}")
                return False

        # Filtering is by user_id on every search and by mongo_id on delete.
        # Unindexed payload filters still work but scan, so this is performance,
        # not correctness — a failure here should not fail provisioning.
        for field in ("user_id", "mongo_id"):
            try:
                cls.client.create_payload_index(
                    collection_name=name, field_name=field, field_schema="keyword",
                )
            except Exception:
                pass
        return True

    @staticmethod
    def _configured_size(info):
        """Vector width from a collection description, across client versions."""
        try:
            vectors = info.config.params.vectors
            return getattr(vectors, "size", None) if not isinstance(vectors, dict) else None
        except Exception:
            return None

    @classmethod
    def health(cls) -> dict:
        """
        Whether the vector store is actually usable, and what is in it.

        Saved-prompt search failed in production with no way to tell why from
        outside. The embedding model turned out to be fine, which left Qdrant —
        but "is it connected, do the collections exist, is anything in them"
        was unanswerable without shell access to the Space. Point counts are
        the decisive signal: an empty collection means writes never landed, a
        populated one means the query or its filter is at fault.

        Deliberately reports no URL or key.
        """
        # Structural facts about the configured URL, never the URL itself: a
        # missing :6333 port is the most common cause of "connection reset by
        # peer" against Qdrant Cloud, and it is indistinguishable from a dead
        # cluster without knowing which of the two you are looking at.
        raw = (settings.QDRANT_URL or "").strip()
        host_part = raw.split("://")[-1]
        out = {
            "connected": False,
            "collections": {},
            "error": None,
            "config": {
                "configured": bool(raw) and raw != ":memory:",
                "in_memory": raw == ":memory:",
                "scheme": raw.split("://")[0] if "://" in raw else None,
                "has_port": ":" in host_part.split("/")[0],
                "looks_like_cloud": "cloud.qdrant.io" in raw,
                "api_key_set": bool(settings.QDRANT_API_KEY),
            },
        }
        try:
            client = cls.get_client()
            out["last_error"] = cls._last_error
            out["collections_ready"] = cls._collections_ready
            if client is None:
                out["error"] = cls._last_error or "client unavailable"
                return out
            out["connected"] = True
            for name in (settings.COLLECTION_NAME, cls.SAVED_COLLECTION):
                try:
                    info = client.get_collection(name)
                    out["collections"][name] = {
                        "exists": True,
                        "points": getattr(info, "points_count", None),
                    }
                except Exception as e:
                    out["collections"][name] = {"exists": False, "error": str(e)[:120]}
        except Exception as e:
            out["error"] = str(e)[:160]
        return out


# In-Memory Fallbacks
in_memory_users = {}
in_memory_prompt_logs = []
in_memory_saved_prompts = {}  # {prompt_id: {doc}}
in_memory_analytics_events = []
