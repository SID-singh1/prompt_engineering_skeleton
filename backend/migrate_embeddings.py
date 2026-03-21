"""
One-time migration script: Re-embed all Qdrant vectors using the new multilingual model.

Old model:  all-MiniLM-L6-v2             (English only)
New model:  paraphrase-multilingual-MiniLM-L12-v2  (50+ languages)

Both models produce 384-dim vectors, but they live in DIFFERENT vector spaces,
so every existing vector must be re-computed with the new model.

Usage (from project root):
    python -m backend.migrate_embeddings

What this does:
    1. Connects to MongoDB + Qdrant using .env credentials
    2. Deletes & recreates both Qdrant collections (prompt_memory, saved_prompt_vectors)
    3. Loads the new multilingual embedding model
    4. Re-embeds all prompt_logs docs   → prompt_memory collection
    5. Re-embeds all saved_prompts docs → saved_prompt_vectors collection
"""

import sys
import uuid
import time

from pymongo import MongoClient
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, Distance, PointStruct
from sentence_transformers import SentenceTransformer

from .core.config import settings


# ─── CONFIG ────────────────────────────────────────────────────────────────────
PROMPT_MEMORY_COLLECTION = settings.COLLECTION_NAME        # "prompt_memory"
SAVED_PROMPTS_COLLECTION = "saved_prompt_vectors"
VECTOR_SIZE = 384
NEW_MODEL_NAME = settings.EMBEDDING_MODEL_NAME             # should already be the multilingual model


def _create_collection(qdrant: QdrantClient, name: str):
    """Delete if exists, then create fresh with 384-dim cosine + user_id index."""
    # Delete old collection
    try:
        qdrant.delete_collection(name)
        print(f"  🗑️  Deleted old collection: '{name}'")
    except Exception:
        pass  # didn't exist

    # Create new
    qdrant.create_collection(
        collection_name=name,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
    )
    print(f"  ✅ Created collection: '{name}'")

    # Add user_id payload index
    try:
        qdrant.create_payload_index(
            collection_name=name,
            field_name="user_id",
            field_schema="keyword",
        )
    except Exception:
        pass


def main():
    print("=" * 60)
    print("🔄 Embedding Migration Script")
    print(f"   New model: {NEW_MODEL_NAME}")
    print("=" * 60)

    # ── 1. Connect to MongoDB ──────────────────────────────────────────────
    mongo_uri = settings.MONGO_URI
    if not mongo_uri:
        print("❌ MONGO_URI not set in .env — cannot migrate.")
        sys.exit(1)

    print("\n📦 Connecting to MongoDB...")
    mongo_client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    try:
        mongo_client.admin.command("ping")
    except Exception as e:
        print(f"❌ MongoDB connection failed: {e}")
        sys.exit(1)

    db = mongo_client["prompt_engine_db"]
    prompt_logs_col = db["prompt_logs"]
    saved_prompts_col = db["saved_prompts"]

    prompt_logs_count = prompt_logs_col.count_documents({})
    saved_prompts_count = saved_prompts_col.count_documents({})
    print(f"   ✅ MongoDB connected — {prompt_logs_count} prompt logs, {saved_prompts_count} saved prompts")

    # ── 2. Connect to Qdrant ──────────────────────────────────────────────
    print("\n📦 Connecting to Qdrant...")
    qdrant_url = settings.QDRANT_URL
    qdrant_api_key = settings.QDRANT_API_KEY

    if not qdrant_url or qdrant_url == ":memory:":
        print("❌ QDRANT_URL not set or is :memory: — cannot migrate a persistent instance.")
        sys.exit(1)

    qdrant = QdrantClient(url=qdrant_url, api_key=qdrant_api_key)
    print(f"   ✅ Qdrant connected ({qdrant_url})")

    # ── 3. Recreate collections ───────────────────────────────────────────
    print("\n🔨 Recreating Qdrant collections...")
    _create_collection(qdrant, PROMPT_MEMORY_COLLECTION)
    _create_collection(qdrant, SAVED_PROMPTS_COLLECTION)

    # ── 4. Load the new embedding model ───────────────────────────────────
    print(f"\n⏳ Loading embedding model: {NEW_MODEL_NAME}")
    start_load = time.time()
    try:
        model = SentenceTransformer(NEW_MODEL_NAME, backend="onnx")
        print(f"   ✅ Model loaded (ONNX backend) in {time.time() - start_load:.1f}s")
    except Exception:
        model = SentenceTransformer(NEW_MODEL_NAME)
        print(f"   ✅ Model loaded (default backend) in {time.time() - start_load:.1f}s")

    def embed(text: str):
        return model.encode(text, convert_to_numpy=True).tolist()

    # ── 5. Re-embed prompt_logs → prompt_memory ───────────────────────────
    print(f"\n📝 Re-embedding {prompt_logs_count} prompt logs → '{PROMPT_MEMORY_COLLECTION}'...")
    success_logs = 0
    skipped_logs = 0
    batch_points = []
    BATCH_SIZE = 50

    for i, doc in enumerate(prompt_logs_col.find({})):
        original = doc.get("original", "")
        enhanced = doc.get("enhanced", "")
        user_id = doc.get("user_id", "")

        if not original or not user_id:
            skipped_logs += 1
            continue

        try:
            vec = embed(original)
            point_id = uuid.uuid4().int % (2**63)
            batch_points.append(PointStruct(
                id=point_id,
                vector=vec,
                payload={
                    "user_id": user_id,
                    "original_prompt": original,
                    "refined_prompt": enhanced or "",
                },
            ))
            success_logs += 1

            # Flush batch
            if len(batch_points) >= BATCH_SIZE:
                qdrant.upsert(collection_name=PROMPT_MEMORY_COLLECTION, points=batch_points)
                batch_points = []
                print(f"   ... processed {i + 1}/{prompt_logs_count}")

        except Exception as e:
            print(f"   ⚠️  Failed to embed prompt log (id={doc.get('_id')}): {e}")
            skipped_logs += 1

    # Flush remaining
    if batch_points:
        qdrant.upsert(collection_name=PROMPT_MEMORY_COLLECTION, points=batch_points)
        batch_points = []

    print(f"   ✅ Done — {success_logs} embedded, {skipped_logs} skipped")

    # ── 6. Re-embed saved_prompts → saved_prompt_vectors ──────────────────
    print(f"\n📝 Re-embedding {saved_prompts_count} saved prompts → '{SAVED_PROMPTS_COLLECTION}'...")
    success_saved = 0
    skipped_saved = 0

    for i, doc in enumerate(saved_prompts_col.find({})):
        content = doc.get("content", "")
        user_id = doc.get("user_id", "")
        mongo_id = str(doc["_id"])

        if not content or not user_id:
            skipped_saved += 1
            continue

        try:
            vec = embed(content)
            point_id = abs(hash(mongo_id)) % (2**63)
            batch_points.append(PointStruct(
                id=point_id,
                vector=vec,
                payload={
                    "user_id": user_id,
                    "mongo_id": mongo_id,
                    "content": content,
                    "title": doc.get("title", "") or "",
                    "tags": doc.get("tags", []) or [],
                },
            ))
            success_saved += 1

            if len(batch_points) >= BATCH_SIZE:
                qdrant.upsert(collection_name=SAVED_PROMPTS_COLLECTION, points=batch_points)
                batch_points = []
                print(f"   ... processed {i + 1}/{saved_prompts_count}")

        except Exception as e:
            print(f"   ⚠️  Failed to embed saved prompt (id={mongo_id}): {e}")
            skipped_saved += 1

    if batch_points:
        qdrant.upsert(collection_name=SAVED_PROMPTS_COLLECTION, points=batch_points)

    print(f"   ✅ Done — {success_saved} embedded, {skipped_saved} skipped")

    # ── 7. Summary ────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("✅ MIGRATION COMPLETE")
    print(f"   Model:           {NEW_MODEL_NAME}")
    print(f"   prompt_memory:   {success_logs} vectors ({skipped_logs} skipped)")
    print(f"   saved_prompts:   {success_saved} vectors ({skipped_saved} skipped)")
    print("=" * 60)
    print("\nYou can now restart the server:")
    print("   python -m uvicorn backend.main:app --reload")


if __name__ == "__main__":
    main()
