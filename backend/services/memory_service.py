
import time
import uuid
from datetime import datetime
from typing import List, Tuple, Optional
from qdrant_client.models import PointStruct, Filter, FieldCondition, MatchValue
from ..core.config import settings
from ..core.database import QdrantDB, MongoDB, in_memory_prompt_logs, in_memory_saved_prompts
from ..services.llm_service import get_embedding

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
                        )
                    ]
                ),
                limit=limit
            ).points
        except Exception as e:
            print(f"⚠️ Search failed: {e}")
            return "No relevant past context found.", 0.0
        
        context_str = ""
        max_score = 0.0
        
        for hit in results:
            if hit.score > max_score:
                max_score = hit.score

            payload = hit.payload
            if hit.score > 0.45:
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
                        FieldCondition(key="user_id", match=MatchValue(value=user_id))
                    ]
                ),
                limit=limit
            ).points
        except Exception as e:
            print(f"⚠️ Passive context search failed: {e}")
            return []

        matched = []
        for hit in results:
            if hit.score < 0.50:
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
                print(f"⚠️ Error fetching recent prompts from Mongo: {e}")

        if MongoDB.prompts_col is None:
            user_logs = [log for log in in_memory_prompt_logs if log.get("user_id") == user_id]
            recent_prompts = [log["original"] for log in user_logs[-limit:]]
            recent_prompts.reverse()
            
        return recent_prompts

    @staticmethod
    def log_prompt(user_id: str, original: str, enhanced: str = None, score: float = 0.0, latency: float = 0.0, source: str = "active", mode: str = "deep"):
        """Logs prompt to Mongo or Memory."""
        log_entry = {
            "user_id": user_id,
            "timestamp": datetime.now(),
            "original": original,
            "enhanced": enhanced,
            "score": score,
            "latency": latency,
            "source": source,
            "mode": mode,
        }
        
        log_id = "memory-only"
        if MongoDB.prompts_col is not None:
            try:
                res = MongoDB.prompts_col.insert_one(log_entry)
                log_id = str(res.inserted_id)
            except: pass
        else:
            in_memory_prompt_logs.append(log_entry)
        
        return log_id

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
                        "original": doc.get("original", ""),
                        "enhanced": doc.get("enhanced", ""),
                        "mode": doc.get("mode", "deep"),
                        "latency": doc.get("latency", 0),
                        "score": doc.get("score", 0),
                        "timestamp": doc.get("timestamp").isoformat() if doc.get("timestamp") else None,
                    })
            except Exception as e:
                print(f"⚠️ Error fetching enhance history: {e}")
        else:
            user_logs = [
                log for log in in_memory_prompt_logs
                if log.get("user_id") == user_id and log.get("source") == "active" and log.get("enhanced")
            ]
            for log in user_logs[-limit:]:
                history.append({
                    "id": "memory",
                    "original": log.get("original", ""),
                    "enhanced": log.get("enhanced", ""),
                    "mode": log.get("mode", "deep"),
                    "latency": log.get("latency", 0),
                    "score": log.get("score", 0),
                    "timestamp": log.get("timestamp").isoformat() if isinstance(log.get("timestamp"), datetime) else None,
                })
            history.reverse()

        return history

    @staticmethod
    def memorize_strategy(user_id: str, original: str, refined: str):
        """Saves high-quality prompts to passive tracking Vector DB."""
        try:
            vec = get_embedding(original)
            if vec:
                q_client = QdrantDB.get_client()
                if q_client:
                    # Use UUID-based point ID to prevent collisions
                    point_id = uuid.uuid4().int % (2**63)
                    q_client.upsert(
                        collection_name=settings.COLLECTION_NAME,
                        points=[PointStruct(
                            id=point_id,
                            vector=vec,
                            payload={
                                "user_id": user_id, 
                                "original_prompt": original, 
                                "refined_prompt": refined
                            }
                        )]
                    )
                    print("💾 New strategy memorized.")
        except Exception as e:
            print(f"❌ Memorization failed: {e}")

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
            print(f"⚠️ Saved prompts search failed: {e}")
            return []

        exclude_set = set(exclude_ids or [])
        matched = []
        for hit in results:
            mongo_id = hit.payload.get("mongo_id", "")
            if mongo_id in exclude_set:
                continue
            if hit.score < 0.40:
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
            vec = get_embedding(content)
            if vec:
                q_client = QdrantDB.get_client()
                if q_client:
                    point_id = abs(hash(mongo_id)) % (2**63)
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
                    print(f"💾 Saved prompt embedded (id={mongo_id})")
        except Exception as e:
            print(f"❌ Saved prompt embedding failed: {e}")

    @staticmethod
    def delete_saved_prompt_vector(mongo_id: str):
        """Remove a saved prompt's vector from Qdrant."""
        try:
            q_client = QdrantDB.get_client()
            if q_client:
                point_id = abs(hash(mongo_id)) % (2**63)
                q_client.delete(
                    collection_name=QdrantDB.SAVED_COLLECTION,
                    points_selector=[point_id],
                )
                print(f"🗑️ Saved prompt vector deleted (id={mongo_id})")
        except Exception as e:
            print(f"⚠️ Could not delete saved prompt vector: {e}")

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
