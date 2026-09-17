
import io
import time
import json
from datetime import datetime
from bson import ObjectId
from fastapi import APIRouter, Depends, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse
from ..models.schemas import TrackRequest, EnhanceRequest, FeedbackRequest
from ..core.config import settings
from ..core.security import verify_jwt
from ..core.ratelimit import enhance_limit, voice_limit
from ..core import usage
from ..core.database import MongoDB, in_memory_users, in_memory_saved_prompts
from ..services.analytics_service import AnalyticsService
from ..services.memory_service import MemoryService
from ..services.llm_service import get_groq_client, mark_groq_rate_limited
from ..services.prompt_builder import _build_enhance_context, _llm_messages, _temperature_for
from ..services import providers
from ..core.logger import logger


router = APIRouter()


# ══════════════════════════════════════════════════════════════
# TIER HELPERS — Subscription-aware model routing + limits
# ══════════════════════════════════════════════════════════════

def get_user_tier(user_id: str) -> str:
    """Look up the user's subscription tier. Defaults to 'free'."""
    if MongoDB.users_col is not None:
        try:
            user = MongoDB.users_col.find_one({"user_id": user_id}, {"subscription_tier": 1})
            if user:
                return user.get("subscription_tier", "free")
        except Exception:
            pass
    else:
        user = in_memory_users.get(user_id, {})
        return user.get("subscription_tier", "free")
    return "free"


def effective_tier(user_id: str, request) -> str:
    """
    A user who brings their own provider key is not spending the shared
    allowance, so they are not rationed against it.
    """
    if getattr(request, "byok_key", None):
        return "byok"
    return get_user_tier(user_id)


def count_today(user_id: str) -> tuple:
    """
    Today's billable enhancements for a user. Returns (count, degraded).

    `degraded` means the datastore could not be read and the number is coming
    from the in-process tally alone, which a restart would have emptied — so
    callers must not treat it as authoritative.

    Both this and the in-process tally count the same shape: an "active" log
    that produced an enhancement. If one definition changes the other has to
    change with it, or the ration drifts.
    """
    from datetime import datetime
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    shadow = usage.get(user_id)

    if MongoDB.prompts_col is not None:
        try:
            stored = MongoDB.prompts_col.count_documents({
                "user_id": user_id,
                "source": "active",
                "enhanced": {"$ne": None},
                "timestamp": {"$gte": today_start},
            })
            # Highest wins: the store is authoritative across restarts, the
            # tally is authoritative for writes the store rejected.
            return max(stored, shadow), False
        except Exception as e:
            logger.warning(f"⚠️ Usage read failed, falling back to in-process tally: {e}")
            return shadow, True

    from ..core.database import in_memory_prompt_logs
    stored = sum(
        1 for log in in_memory_prompt_logs
        if log.get("user_id") == user_id
        and log.get("source") == "active"
        and log.get("enhanced")
        and isinstance(log.get("timestamp"), datetime)
        and log["timestamp"] >= today_start
    )
    return max(stored, shadow), False


def check_daily_limit(user_id: str, tier: str) -> tuple:
    """
    Returns (allowed: bool, count: int, limit: int, degraded: bool).

    This used to initialise count to 0 and swallow every read exception, so any
    Mongo hiccup silently granted an unlimited allowance to everybody. The
    shared Groq key is roughly 100 enhancements/day across the entire user
    base, so that turned one database blip into a drained org quota within
    minutes — which every user then saw as `quota_exhausted`.

    Failing closed is not the answer either: it converts a transient blip into
    a total outage. Instead the in-process tally carries the ration when the
    store is unreachable, and a degraded read additionally clamps shared-key
    tiers to a small emergency allowance, because a process that restarted
    mid-outage starts its tally at zero and cannot prove otherwise.
    """
    limit = settings.TIER_LIMITS.get(tier, settings.SHARED_KEY_DAILY_LIMIT)
    count, degraded = count_today(user_id)

    # BYOK users spend their own quota, so a degraded store is no reason to
    # ration them — they were never drawing on the shared key.
    if degraded and tier != "byok":
        limit = min(limit, usage.DEGRADED_LIMIT)

    return (count < limit, count, limit, degraded)


# ══════════════════════════════════════════════════════════════
# SYSTEM PROMPTS — Mode-Aware, Platform-Aware, Intent-Aware
# ══════════════════════════════════════════════════════════════

@router.post("/track")
def track_prompt(request: TrackRequest, user_id: str = Depends(verify_jwt)):
    """Silently learns from user prompts."""
    logger.info(f"\n🔍 /track — user={user_id[:8]}... prompt=\"{request.prompt[:60]}...\"")
    request.user_id = user_id
    
    MemoryService.log_prompt(
        user_id=request.user_id,
        original=request.prompt,
        source="passive_tracker",
        platform=request.platform,
    )

    # No vector is written here, deliberately.
    #
    # This used to call memorize_strategy(prompt, prompt) — original and
    # refined identical. _build_enhance_context() then retrieves passive
    # matches and keeps only those where `original != refined`, so every point
    # written on this path was discarded on read, 100% of the time. It filled
    # the Qdrant free tier with data that could never be used, and it put a
    # verbatim permanent copy of everything the user typed into the vector
    # store for no benefit at all.
    #
    # Real strategies are still memorised in /enhance, where an actual
    # refinement exists and original != refined holds.
    logger.info(f"   ✅ Logged")
    return {"status": "logged"}


@router.post("/enhance")
def enhance_prompt(request: EnhanceRequest, user_id: str = Depends(enhance_limit)):
    """
    The core prompt engineering endpoint — intent-aware, mode-aware.
    """
    tier = effective_tier(user_id, request)
    allowed, used, limit, degraded = check_daily_limit(user_id, tier)
    degraded_note = (
        " The prompt store is temporarily unreachable, so free usage is capped"
        " lower than usual until it recovers."
        if degraded else ""
    )
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "error": "daily_limit_reached",
                "detail": (
                    f"You've used all {limit} free enhancements for today. "
                    "Add your own free API key in the extension settings for "
                    "1,000 per day." + degraded_note
                    if tier != "byok" else
                    f"Daily limit of {limit} reached."
                ),
                "used": used,
                "limit": limit,
                "tier": tier,
                "degraded": degraded,
                "byok_available": tier != "byok",
            },
        )

    logger.info(f"\n🎯 /enhance — user={user_id[:8]}... mode={request.mode} tier={tier} ({used}/{limit})")
    logger.info(f"   Prompt: \"{request.prompt[:80]}...\"")
    logger.info(f"   Selected IDs: {request.selected_prompt_ids or 'none'}")
    logger.info(f"   Conversation msgs: {len(request.conversation_context or [])}")

    ctx = _build_enhance_context(request, user_id, _fetch_saved_prompt)

    # ── VERBOSE CONTEXT LOGGING ──
    logger.info(f"   ── 📋 Context layers:")
    conv_msgs = len(request.conversation_context or [])
    logger.info(f"      ├─ 💬 Conversation: {conv_msgs} messages{'  (' + ctx['conversation_ctx'][:80] + '...)' if ctx['conversation_ctx'] else ''}")
    logger.info(f"      \u251C\u2500 \U0001F4CC Selected: {len(ctx['selected_context_parts'])} saved prompts")
    for sp in ctx['selected_context_parts']:
        logger.info(f"      \u2502    \u2514\u2500 {sp[:80]}")
    logger.info(f"      \u251C\u2500 \U0001F50D Auto-matched: {len(ctx['similar_saved'])} saved prompts")
    for item in ctx['similar_saved']:
        logger.info(f"      \u2502    \u2514\u2500 \"{item.get('title', 'Untitled')}\" (score: {item['score']})")
    logger.info(f"      \u251C\u2500 \U0001F9E0 Passive: {len(ctx['passive_matches'])} past patterns")
    for pm in ctx['passive_matches']:
        logger.info(f"      \u2502    \u2514\u2500 \"{pm['original'][:50]}...\" \u2192 score: {pm['score']}")
    logger.info(f"      \u2514\u2500 \U0001F4CA Feedback: {'Active' if ctx['feedback_summary'] else 'None'}")

    # ── CALL LLM ──
    # The fallback chain handles key rotation, dead models and provider
    # failover internally. A total failure raises, and we surface it as a real
    # error: the old code initialised enhanced_prompt to the user's own text
    # and swallowed the exception, so when Groq decommissioned the model the
    # endpoint kept returning HTTP 200 and nobody noticed it had stopped working.
    try:
        result = providers.chat(
            messages=_llm_messages(ctx),
            temperature=_temperature_for(ctx["mode"]),
            user_provider=request.byok_provider,
            user_key=request.byok_key,
            user_model=request.byok_model,
        )
    except providers.NoProviderAvailable as e:
        AnalyticsService.record_failure(
            operation="enhance", reason="provider_unavailable",
            platform=request.platform, mode=request.mode, user_id=user_id,
        )
        logger.error(f"❌ All providers failed: {e}")
        return JSONResponse(
            status_code=429 if e.all_rate_limited else 503,
            content={
                "error": "quota_exhausted" if e.all_rate_limited else "enhancement_failed",
                "detail": e.user_message,
                "byok_available": e.all_rate_limited and not request.byok_key,
                "attempts": [{"model": label, "error": err} for label, err in e.attempts],
            },
        )

    enhanced_prompt = result["content"]
    process_time = round(time.time() - ctx["start_time"], 2)
    
    # ── LOG ──
    max_similarity = ctx["similar_saved"][0]["score"] if ctx["similar_saved"] else 0.0
    log_id = None
    if request.tracking_enabled:
        log_id = MemoryService.log_prompt(
            user_id=user_id,
            original=request.prompt,
            enhanced=enhanced_prompt,
            score=max_similarity,
            latency=process_time,
            mode=ctx["mode"],
            platform=request.platform,
            provider=result.get("provider"),
            model=result.get("model"),
            byok=result.get("byok", False),
            input_method="voice" if request.input_method == "voice" else "text",
            input_duration_seconds=request.input_duration_seconds,
        )

    # ── MEMORIZE (if unique) ──
    if request.tracking_enabled and max_similarity < 0.90:
        MemoryService.memorize_strategy(user_id, request.prompt, enhanced_prompt)

    logger.info(f"   ✅ Enhanced in {process_time}s — {len(enhanced_prompt)} chars")
    logger.info(f"   Enhanced: \"{enhanced_prompt[:80]}...\"")

    return {
        "original": request.prompt,
        "enhanced": enhanced_prompt,
        "log_id": log_id,
        "latency": process_time,
        "mode": ctx["mode"],
        "model": result["model"],
        "provider": result["provider"],
        "byok": result["byok"],
        # The client overwrites the user's composer with this text, so it has
        # to know when the model ran out of tokens mid-sentence rather than
        # finishing.
        "truncated": result.get("truncated", False),
        "usage_today": {"used": used + 1, "limit": limit, "tier": tier},
        "context_used": {
            "selected": len(ctx["selected_context_parts"]),
            "auto_matched": len(ctx["similarity_context_parts"]),
            "passive_matched": len(ctx["passive_context_parts"]),
            "conversation_messages": len(request.conversation_context or []),
        },
        "context_details": {
            "auto_matched_prompts": [
                {"title": s.get("title", ""), "content": s.get("content", "")[:200], "score": s["score"]}
                for s in ctx["similar_saved"]
            ],
            "passive_patterns": [
                {"original": pm["original"][:150], "refined": pm["refined"][:150], "score": pm["score"]}
                for pm in ctx["passive_matches"]
            ],
            "conversation_preview": ctx["conversation_ctx"][:300] if ctx["conversation_ctx"] else None,
            "feedback_summary": ctx["feedback_summary"] or None,
        }
    }


@router.post("/enhance/stream")
def enhance_prompt_stream(request: EnhanceRequest, user_id: str = Depends(enhance_limit)):
    """
    Streaming enhancement — returns tokens as Server-Sent Events for real-time UI.
    """
    tier = effective_tier(user_id, request)
    allowed, used, limit, degraded = check_daily_limit(user_id, tier)

    logger.info(f"\n⚡ /enhance/stream — user={user_id[:8]}... mode={request.mode} tier={tier} ({used}/{limit})")
    logger.info(f"   Prompt: \"{request.prompt[:80]}...\"")

    if not allowed:
        def refuse():
            payload = {
                "error": "daily_limit_reached",
                "detail": (
                    f"You've used all {limit} free enhancements for today. "
                    "Add your own free API key in the extension settings for 1,000 per day."
                    if tier != "byok" else f"Daily limit of {limit} reached."
                ),
                "used": used, "limit": limit, "degraded": degraded,
                "byok_available": tier != "byok",
            }
            yield f"data: {json.dumps(payload)}\n\n"
            yield f"data: {json.dumps({'done': True, 'failed': True})}\n\n"
        return StreamingResponse(refuse(), media_type="text/event-stream")

    ctx = _build_enhance_context(request, user_id, _fetch_saved_prompt)

    def generate():
        enhanced_parts = []
        meta = {}
        failure = None

        try:
            for event in providers.chat_stream(
                messages=_llm_messages(ctx),
                temperature=_temperature_for(ctx["mode"]),
                user_provider=request.byok_provider,
                user_key=request.byok_key,
                user_model=request.byok_model,
            ):
                if "token" in event:
                    enhanced_parts.append(event["token"])
                    yield f"data: {json.dumps({'token': event['token']})}\n\n"
                elif "meta" in event:
                    meta = event["meta"]
                elif "error" in event:
                    failure = event["error"]
                    yield f"data: {json.dumps({'error': failure})}\n\n"
        except providers.NoProviderAvailable as e:
            AnalyticsService.record_failure(
                operation="enhance_stream", reason="provider_unavailable",
                platform=request.platform, mode=request.mode, user_id=user_id,
            )
            failure = e.user_message
            logger.error(f"❌ All providers failed (stream): {e}")
            yield "data: " + json.dumps({
                "error": failure,
                "detail": failure,
                "byok_available": e.all_rate_limited and not request.byok_key,
                "attempts": [{"model": m, "error": err} for m, err in e.attempts],
            }) + "\n\n"

        enhanced_prompt = "".join(enhanced_parts)
        process_time = round(time.time() - ctx["start_time"], 2)

        # Only record a real enhancement. Logging an empty string as a success
        # is what let the outage hide inside the metrics for two weeks.
        log_id = None
        if enhanced_prompt.strip():
            max_similarity = ctx["similar_saved"][0]["score"] if ctx["similar_saved"] else 0.0
            if request.tracking_enabled:
                log_id = MemoryService.log_prompt(
                    user_id=user_id,
                    original=request.prompt,
                    enhanced=enhanced_prompt,
                    score=max_similarity,
                    latency=process_time,
                    mode=ctx["mode"],
                    platform=request.platform,
                    provider=meta.get("provider"),
                    model=meta.get("model"),
                    byok=meta.get("byok", False),
                    input_method="voice" if request.input_method == "voice" else "text",
                    input_duration_seconds=request.input_duration_seconds,
                )
            if request.tracking_enabled and max_similarity < 0.90:
                MemoryService.memorize_strategy(user_id, request.prompt, enhanced_prompt)
        elif not failure:
            failure = "The model returned an empty response."
            yield f"data: {json.dumps({'error': failure})}\n\n"

        yield "data: " + json.dumps({
            "done": True,
            "failed": bool(failure) or not enhanced_prompt.strip(),
            "log_id": log_id,
            "latency": process_time,
            "mode": ctx["mode"],
            "model": meta.get("model"),
            "provider": meta.get("provider"),
            "byok": meta.get("byok", False),
            "usage_today": {"used": used + (1 if log_id else 0), "limit": limit, "tier": tier},
            "context_used": {
                "selected": len(ctx["selected_context_parts"]),
                "auto_matched": len(ctx["similarity_context_parts"]),
                "passive_matched": len(ctx["passive_context_parts"]),
                "conversation_messages": len(request.conversation_context or []),
            },
            # Must mirror /enhance's shape. This block was missing here, so the
            # two endpoints returned different payloads for the same work — and
            # since the extension streams, any client feature that named a
            # matched saved prompt silently had nothing to read. Counts alone
            # cannot say WHICH prompt was used.
            "context_details": {
                "auto_matched_prompts": [
                    {"title": sp.get("title", ""), "content": sp.get("content", "")[:200],
                     "score": sp["score"]}
                    for sp in ctx["similar_saved"]
                ],
                "passive_patterns": [
                    {"original": pm["original"][:150], "refined": pm["refined"][:150],
                     "score": pm["score"]}
                    for pm in ctx["passive_matches"]
                ],
                "conversation_preview": ctx["conversation_ctx"][:300] if ctx["conversation_ctx"] else None,
                "feedback_summary": ctx["feedback_summary"] or None,
            },
        }) + "\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/enhance/feedback")
def enhance_feedback(request: FeedbackRequest, user_id: str = Depends(verify_jwt)):
    """Store thumbs up/down feedback on an enhanced prompt."""
    emoji = "👍" if request.rating == "up" else "👎"
    logger.info(f"\n{emoji} /enhance/feedback — user={user_id[:8]}... rating={request.rating} log_id={request.log_id}")
    feedback_doc = {
        "user_id": user_id,
        "log_id": request.log_id,
        "rating": request.rating,
        "original": request.original,
        "enhanced": request.enhanced,
        # datetime, not time.time(): a TTL index only expires BSON dates, so a
        # float timestamp meant this collection would never be pruned.
        "timestamp": datetime.now(),
    }
    
    if MongoDB.db is not None:
        try:
            MongoDB.db["prompt_feedback"].insert_one(feedback_doc)
        except Exception as e:
            logger.warning(f"⚠️ Feedback store error: {e}")
    
    return {"status": "recorded", "rating": request.rating}


@router.get("/enhance/history")
def enhance_history(user_id: str = Depends(verify_jwt)):
    """Returns recent enhancement history for the History tab."""
    logger.info(f"\n📜 /enhance/history — user={user_id[:8]}...")
    history = MemoryService.get_enhance_history(user_id, limit=20)
    logger.info(f"   Returning {len(history)} entries")
    return {"history": history}


@router.get("/enhance/usage")
def enhance_usage(byok: bool = False, user_id: str = Depends(verify_jwt)):
    """
    Returns today's enhancement count for the user.

    Takes `byok` because /enhance rations against effective_tier() — which
    promotes a user supplying their own key to the byok tier — while this
    endpoint used get_user_tier() and reported the free-tier limit. A BYOK user
    saw "12/15" in the usage bar while the server was actually allowing them
    1,000. The extension knows whether it holds a key; it passes that here.

    The count itself now comes from count_today(), the same function /enhance
    rations on, so the number in the UI and the number enforced cannot drift.
    """
    count, degraded = count_today(user_id)
    tier = "byok" if byok else get_user_tier(user_id)
    limit = settings.TIER_LIMITS.get(tier, settings.SHARED_KEY_DAILY_LIMIT)
    if degraded and tier != "byok":
        limit = min(limit, usage.DEGRADED_LIMIT)
    return {"count": count, "limit": limit, "tier": tier, "degraded": degraded}


def _fetch_saved_prompt(prompt_id: str, user_id: str) -> dict:
    """Helper to get a single saved prompt by ID, owned by user_id."""
    if MongoDB.saved_prompts_col is not None:
        try:
            doc = MongoDB.saved_prompts_col.find_one(
                {"_id": ObjectId(prompt_id), "user_id": user_id}
            )
            return doc
        except Exception:
            return None
    else:
        doc = in_memory_saved_prompts.get(prompt_id)
        if doc and doc.get("user_id") == user_id:
            return doc
        return None
