
import uuid
from datetime import datetime
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from ..models.schemas import SavedPromptCreate, SavedPromptUpdate
from ..core.security import verify_jwt
from ..core.database import MongoDB, in_memory_saved_prompts
from ..services.memory_service import MemoryService


def _serialize_dt(val):
    """Safely convert a datetime or string to ISO string."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.isoformat()
    return str(val)

router = APIRouter(prefix="/saved-prompts", tags=["Saved Prompts"])


@router.post("")
def create_saved_prompt(body: SavedPromptCreate, user_id: str = Depends(verify_jwt)):
    """Save a prompt to your personal library. Checks for duplicates first."""
    content = body.content.strip()

    # ── DUPLICATE CHECK ──
    if MongoDB.saved_prompts_col is not None:
        existing = MongoDB.saved_prompts_col.find_one({
            "user_id": user_id,
            "content": content,
        })
        if existing:
            return {"id": str(existing["_id"]), "message": "Prompt already saved.", "duplicate": True}
    else:
        for pid, doc in in_memory_saved_prompts.items():
            if doc.get("user_id") == user_id and doc.get("content") == content:
                return {"id": pid, "message": "Prompt already saved.", "duplicate": True}

    doc = {
        "user_id": user_id,
        "content": content,
        "title": (body.title or "").strip() or None,
        "tags": body.tags or [],
        "platform": body.platform or None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }

    if MongoDB.saved_prompts_col is not None:
        result = MongoDB.saved_prompts_col.insert_one(doc)
        doc_id = str(result.inserted_id)
    else:
        doc_id = str(uuid.uuid4())
        in_memory_saved_prompts[doc_id] = {**doc, "_id": doc_id}

    # Embed in Qdrant for similarity search
    MemoryService.embed_saved_prompt(
        user_id=user_id,
        mongo_id=doc_id,
        content=doc["content"],
        title=doc.get("title", ""),
        tags=doc.get("tags", []),
    )

    return {"id": doc_id, "message": "Prompt saved."}


@router.get("")
def list_saved_prompts(user_id: str = Depends(verify_jwt)):
    """List all saved prompts for the current user."""
    prompts = []

    if MongoDB.saved_prompts_col is not None:
        cursor = MongoDB.saved_prompts_col.find(
            {"user_id": user_id}
        ).sort("created_at", -1)
        for doc in cursor:
            prompts.append({
                "id": str(doc["_id"]),
                "content": doc.get("content", ""),
                "title": doc.get("title"),
                "tags": doc.get("tags", []),
                "platform": doc.get("platform"),
                "created_at": _serialize_dt(doc.get("created_at")),
            })
    else:
        for pid, doc in in_memory_saved_prompts.items():
            if doc.get("user_id") == user_id:
                prompts.append({
                    "id": pid,
                    "content": doc.get("content", ""),
                    "title": doc.get("title"),
                    "tags": doc.get("tags", []),
                    "platform": doc.get("platform"),
                    "created_at": _serialize_dt(doc.get("created_at")),
                })
        prompts.sort(key=lambda x: x.get("created_at") or "", reverse=True)

    return {"prompts": prompts}


@router.put("/{prompt_id}")
def update_saved_prompt(prompt_id: str, body: SavedPromptUpdate, user_id: str = Depends(verify_jwt)):
    """Update a saved prompt. Re-embeds if content changed."""
    update_fields = {}
    if body.content is not None:
        update_fields["content"] = body.content.strip()
    if body.title is not None:
        update_fields["title"] = body.title.strip() or None
    if body.tags is not None:
        update_fields["tags"] = body.tags

    if not update_fields:
        raise HTTPException(status_code=400, detail="No fields to update.")

    update_fields["updated_at"] = datetime.now()

    if MongoDB.saved_prompts_col is not None:
        result = MongoDB.saved_prompts_col.update_one(
            {"_id": ObjectId(prompt_id), "user_id": user_id},
            {"$set": update_fields}
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Prompt not found.")
        
        # If content changed, re-embed
        if "content" in update_fields:
            updated_doc = MongoDB.saved_prompts_col.find_one({"_id": ObjectId(prompt_id)})
            MemoryService.embed_saved_prompt(
                user_id=user_id,
                mongo_id=prompt_id,
                content=updated_doc["content"],
                title=updated_doc.get("title", ""),
                tags=updated_doc.get("tags", []),
            )
    else:
        if prompt_id not in in_memory_saved_prompts:
            raise HTTPException(status_code=404, detail="Prompt not found.")
        doc = in_memory_saved_prompts[prompt_id]
        if doc.get("user_id") != user_id:
            raise HTTPException(status_code=404, detail="Prompt not found.")
        doc.update(update_fields)
        if "content" in update_fields:
            MemoryService.embed_saved_prompt(
                user_id=user_id,
                mongo_id=prompt_id,
                content=doc["content"],
                title=doc.get("title", ""),
                tags=doc.get("tags", []),
            )

    return {"message": "Prompt updated."}


@router.delete("/{prompt_id}")
def delete_saved_prompt(prompt_id: str, user_id: str = Depends(verify_jwt)):
    """Delete a saved prompt from Mongo and Qdrant."""
    if MongoDB.saved_prompts_col is not None:
        result = MongoDB.saved_prompts_col.delete_one(
            {"_id": ObjectId(prompt_id), "user_id": user_id}
        )
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Prompt not found.")
    else:
        if prompt_id not in in_memory_saved_prompts:
            raise HTTPException(status_code=404, detail="Prompt not found.")
        doc = in_memory_saved_prompts[prompt_id]
        if doc.get("user_id") != user_id:
            raise HTTPException(status_code=404, detail="Prompt not found.")
        del in_memory_saved_prompts[prompt_id]

    MemoryService.delete_saved_prompt_vector(prompt_id)
    return {"message": "Prompt deleted."}
