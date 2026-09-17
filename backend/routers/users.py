
from fastapi import APIRouter, Depends, HTTPException
from ..models.schemas import UserProfile
from ..core.security import verify_jwt
from ..core.config import settings
from ..core.database import (
    MongoDB, in_memory_users, in_memory_prompt_logs, in_memory_saved_prompts,
    in_memory_analytics_events,
)
from ..services.memory_service import MemoryService

router = APIRouter()

@router.post("/users/register")
def register_user(profile: UserProfile):
    """Creates or updates a user profile."""
    if MongoDB.users_col is not None:
        MongoDB.users_col.update_one(
            {"user_id": profile.user_id},
            {"$set": profile.dict()},
            upsert=True,
        )
    else:
        in_memory_users[profile.user_id] = profile.dict()
    return {"message": f"User {profile.user_id} registered successfully."}


@router.delete("/users/me")
def delete_me(user_id: str = Depends(verify_jwt)):
    """
    Erase everything held for the signed-in user.

    privacy.html has always told people they can delete their account and data
    — "contact us to request account and data deletion" — while no endpoint,
    no UI and no contact address existed anywhere in the product. That is a
    promise the code could not keep, and the Chrome Web Store user-data
    policies require it to be keepable.
    """
    deleted = {}
    failures = []

    if settings.MONGO_URI and MongoDB.db is None:
        raise HTTPException(
            status_code=503,
            detail="Account storage is unavailable. No deletion was confirmed; please retry.",
        )

    # Delete dependent records first. Keep the profile while any store is
    # unavailable so the user can sign in and retry the deletion.
    vectors = MemoryService.purge_user_vectors(user_id)
    deleted["vectors"] = vectors
    if any(value != "deleted" for value in vectors.values()) or not vectors:
        failures.append("vectors")

    if MongoDB.db is not None:
        for label, spec in (
            ("prompt_logs",    (MongoDB.prompts_col,       {"user_id": user_id})),
            ("saved_prompts",  (MongoDB.saved_prompts_col, {"user_id": user_id})),
            ("feedback",       (MongoDB.feedback_col,      {"user_id": user_id})),
            ("analytics",      (MongoDB.analytics_col,     {"user_id": user_id})),
        ):
            col, query = spec
            if col is None:
                failures.append(label)
                continue
            try:
                deleted[label] = col.delete_many(query).deleted_count
            except Exception as e:
                deleted[label] = f"failed: {e}"
                failures.append(label)
        try:
            deleted["prompt_feedback"] = (
                MongoDB.db["prompt_feedback"].delete_many({"user_id": user_id}).deleted_count
            )
        except Exception as e:
            deleted["prompt_feedback"] = f"failed: {e}"
            failures.append("prompt_feedback")
    else:
        before = len(in_memory_prompt_logs)
        in_memory_prompt_logs[:] = [
            log for log in in_memory_prompt_logs if log.get("user_id") != user_id
        ]
        deleted["prompt_logs"] = before - len(in_memory_prompt_logs)
        for pid in [
            pid for pid, doc in in_memory_saved_prompts.items()
            if doc.get("user_id") == user_id
        ]:
            in_memory_saved_prompts.pop(pid, None)

    in_memory_analytics_events[:] = [
        event for event in in_memory_analytics_events
        if event.get("user_id") != user_id
    ]

    if failures:
        raise HTTPException(
            status_code=503,
            detail={"message": "Some data could not be deleted. Please retry; your account remains available.",
                    "failed_stores": failures},
        )

    if MongoDB.db is not None:
        try:
            deleted["profile"] = MongoDB.users_col.delete_many({"user_id": user_id}).deleted_count
        except Exception:
            raise HTTPException(status_code=503, detail="Account data deletion is incomplete. Please retry.")
    else:
        in_memory_users.pop(user_id, None)
    return {"message": "Account and associated data deleted.", "deleted": deleted}
