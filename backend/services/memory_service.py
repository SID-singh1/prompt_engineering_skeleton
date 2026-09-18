
import re
import time
import uuid
from datetime import datetime
from typing import List, Tuple, Optional
from qdrant_client.models import (
    PointStruct, Filter, FieldCondition, MatchValue, FilterSelector,
)
from ..core.config import settings
from ..core.database import QdrantDB, MongoDB, in_memory_prompt_logs, in_memory_saved_prompts
from ..core import usage
from ..services.llm_service import get_embedding
from ..core.logger import logger
from ..core.logger import logger




# Namespace for deriving a stable Qdrant point id from a Mongo document id.
# Any fixed UUID works; this one must never change, or every existing point
# becomes unreachable by id again.
_POINT_NS = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")
_PASSIVE_POINT_NS = uuid.UUID("737a39ef-6e2f-4d97-9c6b-68900f2638e9")


def point_id_for(mongo_id: str) -> str:
    """
    Stable Qdrant point id for a saved prompt.

    Was `abs(hash(mongo_id)) % (2**63)`. Python randomises str hashing per
    process (PEP 456), so the id computed when a prompt was saved and the id
    computed when it was later deleted came from different seeds and did not
    match. Qdrant does not error on deleting a point that does not exist, so
    every delete was a silent no-op and the vector kept being retrieved and
    spliced into that user's future enhancements forever.
    """
    return str(uuid.uuid5(_POINT_NS, mongo_id))


# Credentials that get pasted into a chat box by accident. Anything matching is
# masked before it is written to Mongo or embedded into Qdrant — an embedded
# secret is otherwise permanent and gets re-injected verbatim into later
# unrelated prompts as "context".
_SECRET_PATTERNS = [
    # Prefixed provider keys. Both separators: Groq issues gsk_, OpenAI sk-.
    re.compile(r"\b(?:sk|gsk|pk|rk)[-_](?:ant[-_])?[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bAIza[A-Za-z0-9_\-]{30,}"),                       # Google API
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),                    # GitHub tokens
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                            # AWS access key id
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),                 # Slack
    re.compile(r"\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),  # JWT
]

# Labelled form: KEY=value / "password": "...". No leading \b — the label is
# often glued to a prefix by an underscore (GROQ_API_KEY=...), and _ is a word
# character, so \b never matches there.
_LABELLED_SECRET = re.compile(
    r"(?i)(?:api[_\- ]?key|secret[_\- ]?key|secret|password|passwd|token|bearer)"
    r"\s*[:=]\s*[\"\']?([A-Za-z0-9_\-]{12,})[\"\']?"
)

_REDACTED = "[REDACTED]"


def redact_secrets(text: str) -> str:
    """Mask anything that looks like a credential. Never raises."""
    if not text:
        return text
    try:
        out = text
        for pat in _SECRET_PATTERNS:
            out = pat.sub(_REDACTED, out)
        # The labelled form keeps its label so the sentence still reads.
        out = _LABELLED_SECRET.sub(
            lambda m: m.group(0).replace(m.group(1), _REDACTED), out
        )
        return out
    except Exception:
        return text


class MemoryService:

    # =========================================================================
    # PASSIVE TRACKING (searches the prompt_memory collection)
    # =========================================================================

    @staticmethod
    def retrieve_context(user_id: str, query_text: str, limit: int = 3) -> Tuple[str, float]:
        """
        Finds similar past prompts from PASSIVE tracking.
        Returns: (context_str, max_score)
        """
        qdrant = QdrantDB.get_client()
        
        if qdrant is None:
            return "No relevant past context found.", 0.0

        query_vector = get_embedding(query_text)
        if query_vector is None:
            return "No relevant past context found.", 0.0

        try:
            results = qdrant.query_points(
                collection_name=settings.COLLECTION_NAME,
                query=query_vector,
                query_filter=Filter(
                    must=[
                        FieldCondition(
                            key="user_id",
                            match=MatchValue(value=user_id)
                        ),
                        FieldCondition(key="approved", match=MatchValue(value=True)),
                    ]
                ),
                limit=limit
            ).points
        except Exception as e:
            logger.warning(f"⚠️ Search failed: {e}")
            return "No relevant past context found.", 0.0
        
        context_str = ""
        max_score = 0.0
        
        for hit in results:
            if hit.score > max_score:
                max_score = hit.score

            payload = hit.payload
            if hit.score >= settings.PASSIVE_CONTEXT_MIN_SCORE:
                context_str += f"- Past Prompt: \"{payload.get('original_prompt')}\"\n"
                context_str += f"- Refined Version: \"{payload.get('refined_prompt')}\"\n\n"
                
        final_context = context_str if context_str else "No relevant past context found."
        return final_context, max_score

    @staticmethod
    def retrieve_passive_context(user_id: str, query_text: str, limit: int = 3) -> List[dict]:
        """
        Retrieve relevant past prompts from passive tracking for use in enhancement.
        Returns list of dicts with original and refined prompts + similarity scores.
        """
        qdrant = QdrantDB.get_client()
        if qdrant is None:
            return []

        query_vector = get_embedding(query_text)
        if query_vector is None:
            return []

        try:
            results = qdrant.query_points(
                collection_name=settings.COLLECTION_NAME,
                query=query_vector,
                query_filter=Filter(
                    must=[
                        FieldCondition(key="user_id", match=MatchValue(value=user_id)),
                        FieldCondition(key="approved", match=MatchValue(value=True)),
                    ]
                ),
                limit=limit
            ).points
        except Exception as e:
            logger.error(f"❌ Passive context search FAILED (not empty — failed): {e}")
            QdrantDB.reset()
            return []

        matched = []
        for hit in results:
            if hit.score < settings.PASSIVE_CONTEXT_MIN_SCORE:
                continue
            matched.append({
                "original": hit.payload.get("original_prompt", ""),
                "refined": hit.payload.get("refined_prompt", ""),
                "score": round(hit.score, 3),
            })
        return matched

    @staticmethod
    def get_recent_prompts(user_id: str, limit: int = 5) -> List[str]:
        """Fetches most recent prompts from passive log."""
        recent_prompts = []
        
        if MongoDB.prompts_col is not None:
            try:
                cursor = MongoDB.prompts_col.find(
                    {"user_id": user_id}
                ).sort("timestamp", -1).limit(limit)
                
                for doc in cursor:
                    if "original" in doc:
                        recent_prompts.append(doc["original"])
            except Exception as e:
                logger.warning(f"⚠️ Error fetching recent prompts from Mongo: {e}")

        if MongoDB.prompts_col is None:
            user_logs = [log for log in in_memory_prompt_logs if log.get("user_id") == user_id]
            recent_prompts = [log["original"] for log in user_logs[-limit:]]
            recent_prompts.reverse()
            
        return recent_prompts

    @staticmethod
    def log_prompt(user_id: str, original: str, enhanced: str = None, score: float = 0.0, latency: float = 0.0, source: str = "active", mode: str = "deep", platform: str = None, provider: str = None, model: str = None, byok: bool = False, input_method: str = "text", input_duration_seconds: float = None):
        """Logs prompt to Mongo or Memory."""
        log_entry = {
            "log_id": uuid.uuid4().hex,
            "user_id": user_id,
            "timestamp": datetime.now(),
            "original": redact_secrets(original),
            "enhanced": redact_secrets(enhanced),
            "score": score,
            "latency": latency,
            "source": source,
            "mode": mode,
        }
        # Only allow known values into analytics. This is metadata supplied by
        # a client, not a source of truth about the user's prompt.
        log_entry["input_method"] = "voice" if input_method == "voice" else "text"
        if isinstance(input_duration_seconds, (int, float)) and input_duration_seconds > 0:
            log_entry["input_duration_seconds"] = round(float(input_duration_seconds), 3)
        if platform:
            log_entry["platform"] = platform
        if provider:
            log_entry["provider"] = provider
        if model:
            log_entry["model"] = model
        log_entry["byok"] = bool(byok)

        # Count the enhancement before attempting the write, and count it on
        # exactly the shape check_daily_limit() counts in Mongo (an active log
        # that produced an enhancement). Doing it here rather than in the
        # success branch means the tally holds even when the write fails, which
        # is the case that previously handed the user an unlimited allowance.
        if source == "active" and enhanced:
            usage.record(user_id)

        if MongoDB.prompts_col is not None:
            try:
                MongoDB.prompts_col.insert_one(log_entry)
            except Exception as e:
                # Was a bare `except: pass`, which also swallowed
                # KeyboardInterrupt and SystemExit and left no trace anywhere —
                # the endpoint still returned 200 with an incremented usage
                # count, so a dead database looked exactly like a healthy one.
                logger.warning(f"⚠️ Prompt log write failed: {e}")
                in_memory_prompt_logs.append(log_entry)
        else:
            in_memory_prompt_logs.append(log_entry)

        return log_entry["log_id"]

    @staticmethod
    def get_enhance_history(user_id: str, limit: int = 20) -> List[dict]:
        """Fetches recent enhancement logs for the history tab."""
        history = []

        if MongoDB.prompts_col is not None:
            try:
                cursor = MongoDB.prompts_col.find(
                    {"user_id": user_id, "source": "active", "enhanced": {"$ne": None}}
                ).sort("timestamp", -1).limit(limit)

                for doc in cursor:
                    history.append({
                        "id": str(doc["_id"]),
                        "log_id": doc.get("log_id"),
                        "original": doc.get("original", ""),
                        "enhanced": doc.get("enhanced", ""),
                        "mode": doc.get("mode", "deep"),
                        "latency": doc.get("latency", 0),
                        "score": doc.get("score", 0),
                        "timestamp": doc.get("timestamp").isoformat() if doc.get("timestamp") else None,
                    })
            except Exception as e:
                logger.warning(f"⚠️ Error fetching enhance history: {e}")
        # Mongo can be configured but a particular insert may have failed and
        # fallen back to process memory. Keep those recent entries visible so
        # History → Use can retry approval after a transient vector failure.
        seen = {item.get("log_id") for item in history}
        user_logs = [
            log for log in in_memory_prompt_logs
            if log.get("user_id") == user_id and log.get("source") == "active"
            and log.get("enhanced") and log.get("log_id") not in seen
        ]
        for log in user_logs[-limit:]:
            history.append({
                "id": "memory",
                "log_id": log.get("log_id"),
                "original": log.get("original", ""),
                "enhanced": log.get("enhanced", ""),
                "mode": log.get("mode", "deep"),
                "latency": log.get("latency", 0),
                "score": log.get("score", 0),
                "timestamp": log.get("timestamp").isoformat() if isinstance(log.get("timestamp"), datetime) else None,
            })

        history.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
        return history[:limit]

    @staticmethod
    def memorize_strategy(user_id: str, original: str, refined: str, *, approval_id: str = None) -> bool:
        """Write only an approved rewrite, idempotently, to passive memory."""
        if not approval_id or not original.strip() or not refined.strip() or original == refined:
            return False
        original = redact_secrets(original)
        refined = redact_secrets(refined)
        try:
            vec = get_embedding(original)
            if vec:
                q_client = QdrantDB.get_client()
                if q_client:
                    # Retries must overwrite the same point, never duplicate it.
                    point_id = str(uuid.uuid5(_PASSIVE_POINT_NS, f"{user_id}:{approval_id}"))
                    q_client.upsert(
                        collection_name=settings.COLLECTION_NAME,
                        points=[PointStruct(
                            id=point_id,
                            vector=vec,
                            payload={
                                "user_id": user_id, 
                                "original_prompt": original, 
                                "refined_prompt": refined,
                                "approved": True,
                                "approval_id": approval_id,
                            }
                        )]
                    )
                    logger.info("💾 New strategy memorized.")
                    return True
        except Exception as e:
            logger.error(f"❌ Memorization failed: {e}")
        return False

    @staticmethod
    def approve_enhancement(user_id: str, log_id: str) -> Optional[dict]:
        """Approve a server-owned enhancement after successful composer apply.

        The client sends only an opaque log ID; it cannot supply memory text or
        approve another user's log. A retry reuses the same Qdrant point ID.
        """
        if not log_id or len(log_id) > 64:
            return None

        doc = None
        persistent = False
        if MongoDB.prompts_col is not None:
            try:
                doc = MongoDB.prompts_col.find_one({
                    "user_id": user_id, "log_id": log_id, "source": "active",
                })
                persistent = doc is not None
            except Exception as exc:
                logger.warning(f"⚠️ Approval log lookup failed: {exc}")
        if doc is None:
            doc = next((item for item in in_memory_prompt_logs
                        if item.get("user_id") == user_id
                        and item.get("log_id") == log_id
                        and item.get("source") == "active"), None)
        if doc is None or not doc.get("original") or not doc.get("enhanced"):
            return None

        # A Mongo write may have fallen back to process memory. Never create a
        # durable vector whose approval record disappears on restart. Restore
        # the log first, or fail closed while the configured store is down.
        if not persistent and (MongoDB.prompts_col is not None or settings.MONGO_URI):
            if MongoDB.prompts_col is None:
                return {"status": "unavailable", "memory_saved": False}
            try:
                MongoDB.prompts_col.insert_one(doc)
                persistent = True
            except Exception as exc:
                logger.warning(f"⚠️ Approval log recovery failed: {exc}")
                return {"status": "unavailable", "memory_saved": False}

        def record(fields: dict) -> bool:
            if persistent:
                try:
                    MongoDB.prompts_col.update_one(
                        {"user_id": user_id, "log_id": log_id, "source": "active"},
                        {"$set": fields},
                    )
                except Exception as exc:
                    logger.warning(f"⚠️ Approval state write failed: {exc}")
                    return False
            doc.update(fields)
            return True

        if not doc.get("accepted_at") and not record({"accepted_at": datetime.now()}):
            return {"status": "unavailable", "memory_saved": False}
        if doc.get("memory_saved"):
            return {"status": "accepted", "memory_saved": True}

        # An already-near-duplicate or unchanged rewrite is accepted, but it
        # does not need a new passive memory point.
        if float(doc.get("score") or 0.0) >= 0.90 or doc["original"] == doc["enhanced"]:
            return {"status": "accepted", "memory_saved": False}
        saved = MemoryService.memorize_strategy(
            user_id, doc["original"], doc["enhanced"], approval_id=log_id,
        )
        if saved:
            record({"memory_saved": True})
        return {"status": "accepted", "memory_saved": saved}

    @staticmethod
    def get_prompt_log(log_id: str, user_id: str) -> Optional[dict]:
        """Fetch a prompt log by log_id and user_id."""
        if MongoDB.prompts_col is not None:
            try:
                doc = MongoDB.prompts_col.find_one({"log_id": log_id, "user_id": user_id, "source": "active"})
                if doc:
                    return doc
            except Exception as exc:
                logger.warning(f"⚠️ Prompt log lookup failed: {exc}")
        return next((item for item in in_memory_prompt_logs
                     if item.get("user_id") == user_id
                     and item.get("log_id") == log_id
                     and item.get("source") == "active"), None)

    # =========================================================================
    # SAVED PROMPTS (searches the saved_prompt_vectors collection)
    # =========================================================================

    @staticmethod
    def search_saved_prompts(user_id: str, query_text: str, limit: int = 5, exclude_ids: Optional[List[str]] = None) -> List[dict]:
        """
        Semantic search ONLY against the user's saved prompts.
        Returns list of dicts: [{mongo_id, content, title, tags, score}, ...]
        """
        qdrant = QdrantDB.get_client()
        if qdrant is None:
            return []

        query_vector = get_embedding(query_text)
        if query_vector is None:
            return []

        try:
            results = qdrant.query_points(
                collection_name=QdrantDB.SAVED_COLLECTION,
                query=query_vector,
                query_filter=Filter(
                    must=[
                        FieldCondition(key="user_id", match=MatchValue(value=user_id))
                    ]
                ),
                limit=limit + (len(exclude_ids) if exclude_ids else 0),
            ).points
        except Exception as e:
            # Distinguished from "no matches" on purpose. These read identically
            # to the caller — an empty list — which is how a dead vector store
            # stayed invisible for months while the library appeared to work.
            logger.error(f"❌ Saved-prompt search FAILED (not empty — failed): {e}")
            QdrantDB.reset()
            return []

        exclude_set = set(exclude_ids or [])
        matched = []
        for hit in results:
            mongo_id = hit.payload.get("mongo_id", "")
            if mongo_id in exclude_set:
                continue
            if hit.score < settings.SAVED_CONTEXT_MIN_SCORE:
                continue
            matched.append({
                "mongo_id": mongo_id,
                "content": hit.payload.get("content", ""),
                "title": hit.payload.get("title", ""),
                "tags": hit.payload.get("tags", []),
                "score": round(hit.score, 3),
            })
            if len(matched) >= limit:
                break

        return matched

    @staticmethod
    def embed_saved_prompt(user_id: str, mongo_id: str, content: str, title: str = "", tags: list = None):
        """Embed a saved prompt into the saved_prompt_vectors Qdrant collection."""
        try:
            content = redact_secrets(content)
            vec = get_embedding(content)
            if not vec:
                # Silent before. The prompt still saved to Mongo and appeared in
                # the user's library, but no vector existed, so it could never
                # be retrieved — a library that looks fine and never matches.
                logger.error("❌ Saved prompt NOT embedded: embedding model unavailable "
                      f"(mongo_id={mongo_id}). Saved-prompt search will not find it.")
            if vec:
                q_client = QdrantDB.get_client()
                if q_client:
                    # Deterministic, so re-embedding after an edit overwrites
                    # the old point instead of leaving the pre-edit text in the
                    # index to outrank the correction.
                    point_id = point_id_for(mongo_id)
                    q_client.upsert(
                        collection_name=QdrantDB.SAVED_COLLECTION,
                        points=[PointStruct(
                            id=point_id,
                            vector=vec,
                            payload={
                                "user_id": user_id,
                                "mongo_id": mongo_id,
                                "content": content,
                                "title": title or "",
                                "tags": tags or [],
                            }
                        )]
                    )
                    logger.info(f"💾 Saved prompt embedded (id={mongo_id})")
        except Exception as e:
            logger.error(f"❌ Saved prompt embedding FAILED (mongo_id={mongo_id}): {e}")
            logger.info("   This prompt is in the library but will never be retrieved.")
            QdrantDB.reset()

    @staticmethod
    def delete_saved_prompt_vector(mongo_id: str, user_id: str = None):
        """
        Remove a saved prompt's vector from Qdrant.

        Deletes by payload filter rather than by point id. Point ids written
        before the switch to point_id_for() came from a per-process randomised
        hash and cannot be recomputed, so an id-based delete could never reach
        them. Matching on the mongo_id payload field reaches every point
        regardless of which scheme wrote it, which also means this call cleans
        up its own historical orphans the next time a user deletes something.
        """
        try:
            q_client = QdrantDB.get_client()
            if q_client is None:
                return
            must = [FieldCondition(key="mongo_id", match=MatchValue(value=mongo_id))]
            if user_id:
                must.append(FieldCondition(key="user_id", match=MatchValue(value=user_id)))
            q_client.delete(
                collection_name=QdrantDB.SAVED_COLLECTION,
                points_selector=FilterSelector(filter=Filter(must=must)),
            )
            logger.info(f"🗑️ Saved prompt vector deleted (mongo_id={mongo_id})")
        except Exception as e:
            logger.warning(f"⚠️ Could not delete saved prompt vector: {e}")

    @staticmethod
    def purge_user_vectors(user_id: str) -> dict:
        """
        Delete every vector belonging to a user from both Qdrant collections.

        Backs the "delete your data" right the privacy policy promises. Filter
        based, so it does not depend on being able to recompute any point id.
        """
        removed = {}
        try:
            q_client = QdrantDB.get_client()
            if q_client is None:
                return {"qdrant": "unavailable"}
            selector = FilterSelector(filter=Filter(must=[
                FieldCondition(key="user_id", match=MatchValue(value=user_id))
            ]))
            for collection in (settings.COLLECTION_NAME, QdrantDB.SAVED_COLLECTION):
                try:
                    q_client.delete(collection_name=collection, points_selector=selector, wait=True)
                    removed[collection] = "deleted"
                except Exception as e:
                    removed[collection] = f"failed: {e}"
        except Exception as e:
            removed["error"] = str(e)
        return removed

    @staticmethod
    def get_user_feedback_summary(user_id: str, limit: int = 20) -> str:
        """
        Analyze recent feedback to determine user preferences.
        Returns a summary string for the system prompt.
        """
        if MongoDB.db is None:
            return ""

        try:
            feedback_col = MongoDB.db["prompt_feedback"]
            cursor = feedback_col.find({"user_id": user_id}).sort("timestamp", -1).limit(limit)
            
            ups = 0
            downs = 0
            down_originals = []
            
            for doc in cursor:
                if doc.get("rating") == "up":
                    ups += 1
                elif doc.get("rating") == "down":
                    downs += 1
                    if doc.get("original"):
                        down_originals.append(doc["original"][:100])
            
            if ups + downs < 3:
                return ""  # Not enough data
            
            parts = []
            if downs > ups:
                parts.append("The user has been dissatisfied with recent enhancements. Be more careful with the refinement — stay closer to the original intent.")
            if downs > 0 and down_originals:
                parts.append(f"Recent prompts the user was unhappy with (keep these patterns in mind): {'; '.join(down_originals[:3])}")
            if ups > downs * 2:
                parts.append("The user has been very satisfied with recent enhancements. Continue with the current approach.")
            
            return "\n".join(parts)
        except Exception:
            return ""
