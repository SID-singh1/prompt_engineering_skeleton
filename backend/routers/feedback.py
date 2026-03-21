
from datetime import datetime
from fastapi import APIRouter, Depends
from ..models.schemas import UserFeedbackRequest
from ..core.security import verify_jwt
from ..core.database import MongoDB

router = APIRouter()


@router.post("/feedback")
def submit_feedback(request: UserFeedbackRequest, user_id: str = Depends(verify_jwt)):
    """
    Submit general feedback / bug report.
    Stored in the 'user_feedback' collection (separate from prompt_feedback).
    """
    print(f"\n💬 /feedback — user={user_id[:8]}... type={request.type}")

    feedback_doc = {
        "user_id": user_id,
        "email": request.email,
        "type": request.type,
        "message": request.message,
        "source": request.source or "extension",
        "page_url": request.page_url,
        "browser_info": request.browser_info,
        "timestamp": datetime.now(),
        "status": "new",
    }

    if MongoDB.feedback_col is not None:
        try:
            MongoDB.feedback_col.insert_one(feedback_doc)
            print(f"   ✅ Feedback stored")
        except Exception as e:
            print(f"   ⚠️ Feedback store error: {e}")
    else:
        print(f"   ⚠️ MongoDB unavailable — feedback lost")

    return {"status": "received", "type": request.type}


@router.get("/feedback/mine")
def get_my_feedback(user_id: str = Depends(verify_jwt)):
    """
    Returns the user's recent feedback submissions (last 5).
    Used by the extension to show 'Recent Feedback' section.
    """
    items = []

    if MongoDB.feedback_col is not None:
        try:
            cursor = MongoDB.feedback_col.find(
                {"user_id": user_id}
            ).sort("timestamp", -1).limit(5)

            for doc in cursor:
                items.append({
                    "type": doc.get("type", "general"),
                    "message": doc.get("message", "")[:100],
                    "timestamp": doc.get("timestamp").isoformat() if doc.get("timestamp") else None,
                    "status": doc.get("status", "new"),
                })
        except Exception as e:
            print(f"⚠️ Error fetching user feedback: {e}")

    return {"feedback": items}
