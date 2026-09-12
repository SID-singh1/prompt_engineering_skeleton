
from fastapi import APIRouter, Depends
from ..models.schemas import UserProfile
from ..core.security import verify_jwt
from ..core.database import (
    MongoDB, in_memory_users, in_memory_prompt_logs, in_memory_saved_prompts,
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

    if MongoDB.db is not None:
        for label, spec in (
            ("profile",        (MongoDB.users_col,         {"user_id": user_id})),
            ("prompt_logs",    (MongoDB.prompts_col,       {"user_id": user_id})),
            ("saved_prompts",  (MongoDB.saved_prompts_col, {"user_id": user_id})),
            ("feedback",       (MongoDB.feedback_col,      {"user_id": user_id})),
        ):
            col, query = spec
            if col is None:
                continue
            try:
                deleted[label] = col.delete_many(query).deleted_count
            except Exception as e:
                deleted[label] = f"failed: {e}"
        try:
            deleted["prompt_feedback"] = (
                MongoDB.db["prompt_feedback"].delete_many({"user_id": user_id}).deleted_count
            )
        except Exception as e:
            deleted["prompt_feedback"] = f"failed: {e}"
    else:
        in_memory_users.pop(user_id, None)
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

    deleted["vectors"] = MemoryService.purge_user_vectors(user_id)
    return {"message": "Account and associated data deleted.", "deleted": deleted}
