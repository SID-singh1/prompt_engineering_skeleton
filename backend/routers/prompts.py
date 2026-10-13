import io
import re
import time
import json
import threading
from datetime import datetime
from typing import Optional
from bson import ObjectId
from fastapi import APIRouter, Depends, UploadFile, File, Form, Request, BackgroundTasks
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
from ..services import providers
from ..core.logger import logger


router = APIRouter()


# ══════════════════════════════════════════════════════════════
# PROMPT CONSTANTS AND CONTEXT BUILDER
# ══════════════════════════════════════════════════════════════
# One copy, in services/prompt_builder.py. A second copy pasted here drifted
# (its language detector read "the" and "me" as Hindi, so English prompts came
# back in Hinglish); tests/test_prompt_builder_single_source.py now fails if a
# copy reappears.
from ..services.prompt_builder import (  # noqa: E402
    SYSTEM_PROMPT_BASE, MODE_INSTRUCTIONS, PLATFORM_HINTS, LANGUAGE_NAMES,
    OUTPUT_INSTRUCTION, STEERING_TURN, _detect_text_language, _conversation_context,
    _llm_messages, _temperature_for, _context_used, _context_details,
    _build_enhance_context as _build_context,
)


# ══════════════════════════════════════════════════════════════
# TRANSCRIPTION HELPERS
# ══════════════════════════════════════════════════════════════

_TRANSCRIPTION_LANGUAGE_CODES = {
    "english": "en",
    "hindi": "hi",
    "urdu": "hi",
    "spanish": "es",
}

def _transcription_parts(result) -> tuple[str, str]:
    if isinstance(result, dict):
        text = result.get("text", "")
        language = result.get("language", "")
    else:
        text = getattr(result, "text", "")
        language = getattr(result, "language", "")
    normalized = str(language or "").strip().lower()
    code = _TRANSCRIPTION_LANGUAGE_CODES.get(normalized)
    if code is None and len(normalized) == 2 and normalized.isalpha():
        code = normalized
    return str(text or "").strip(), code or "unknown"


def _build_enhance_context(request: EnhanceRequest, user_id: str, fetch_saved_prompt_fn=None) -> dict:
    """The shared builder, reading attached saved prompts from this router's store."""
    return _build_context(request, user_id, fetch_saved_prompt_fn or _fetch_saved_prompt)


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
    """A user supplying BYOK is not rationed against shared allowance."""
    if getattr(request, "byok_key", None):
        return "byok"
    return get_user_tier(user_id)


def count_today(user_id: str) -> tuple:
    """Today's billable enhancements for a user. Returns (count, degraded)."""
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
    """Returns (allowed: bool, count: int, limit: int, degraded: bool)."""
    limit = settings.TIER_LIMITS.get(tier, settings.SHARED_KEY_DAILY_LIMIT)
    count, degraded = count_today(user_id)

    if degraded and tier != "byok":
        limit = min(limit, usage.DEGRADED_LIMIT)

    return (count < limit, count, limit, degraded)


# ══════════════════════════════════════════════════════════════
# ROUTES
# ══════════════════════════════════════════════════════════════

@router.post("/track")
def track_prompt(request: TrackRequest, user_id: str = Depends(verify_jwt)):
    """Silently logs user prompts without storing vector embeddings."""
    logger.info(f"\n🔍 /track — user={user_id[:8]}... len={len(request.prompt)}")
    request.user_id = user_id
    
    MemoryService.log_prompt(
        user_id=request.user_id,
        original=request.prompt,
        source="passive_tracker",
        platform=request.platform,
    )
    logger.info(f"   ✅ Logged")
    return {"status": "logged"}


def _async_evaluate_prompt(log_id: str, user_id: str, original: str, enhanced: str, context_str: str = ""):
    """Asynchronously evaluates prompt quality in background and persists to database."""
    if not log_id or not original or not enhanced:
        return
    try:
        from .user_analytics import judge_prompt_improvement
        evaluation = judge_prompt_improvement(
            original_prompt=original,
            enhanced_prompt=enhanced,
            extracted_context=context_str,
        )
        if MongoDB.prompts_col is not None:
            MongoDB.prompts_col.update_one(
                {"log_id": log_id},
                {"$set": {"evaluation": evaluation}}
            )
        else:
            for item in in_memory_prompt_logs:
                if item.get("log_id") == log_id:
                    item["evaluation"] = evaluation
                    break
        logger.info(f"   🎯 Background evaluation saved for {log_id}: score={evaluation.get('enhanced_score')}/100 (+{evaluation.get('improvement_delta')})")
    except Exception as e:
        logger.warning(f"⚠️ Background evaluation error for {log_id}: {e}")


@router.post("/enhance")
def enhance_prompt(
    request: EnhanceRequest,
    user_id: str = Depends(enhance_limit),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """The core prompt engineering endpoint — intent-aware, mode-aware."""
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

    ctx = _build_enhance_context(request, user_id, _fetch_saved_prompt)

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
    
    # Log the enhancement; DO NOT memorize here. Memorization happens on /enhance/accept.
    # Always logged, whatever tracking_enabled says: this log is the user's
    # History, the log_id that accept and feedback point at, and the count the
    # daily limit reads. Prompt tracking only governs prompts sent normally to
    # a chat (/track); gating this on it gave anyone who switched tracking off
    # unlimited rewrites on the shared key and an empty History.
    max_similarity = ctx["similar_saved"][0]["score"] if ctx["similar_saved"] else 0.0
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

    # The quality score is worked out after the fact, off the request path, and
    # written onto the log by log_id. It rides on the log existing, not on
    # tracking: History shows the score, so gating it would empty the column
    # for anyone with tracking off.
    if log_id:
        ctx_snippet = ctx.get("conversation_ctx", "") or ""
        if background_tasks is not None:
            background_tasks.add_task(
                _async_evaluate_prompt,
                log_id=log_id,
                user_id=user_id,
                original=request.prompt,
                enhanced=enhanced_prompt,
                context_str=ctx_snippet,
            )
        else:
            threading.Thread(
                target=_async_evaluate_prompt,
                args=(log_id, user_id, request.prompt, enhanced_prompt, ctx_snippet),
                daemon=True,
            ).start()

    logger.info(f"   ✅ Enhanced in {process_time}s — {len(enhanced_prompt)} chars")

    return {
        "original": request.prompt,
        "enhanced": enhanced_prompt,
        "log_id": log_id,
        "latency": process_time,
        "mode": ctx["mode"],
        "model": result["model"],
        "provider": result["provider"],
        "byok": result["byok"],
        "truncated": result.get("truncated", False),
        "usage_today": {"used": used + 1, "limit": limit, "tier": tier},
        "context_used": _context_used(ctx, request),
        "context_details": _context_details(ctx)
    }


@router.post("/enhance/stream")
def enhance_prompt_stream(request: EnhanceRequest, user_id: str = Depends(enhance_limit)):
    """Streaming enhancement — returns tokens as Server-Sent Events."""
    tier = effective_tier(user_id, request)
    allowed, used, limit, degraded = check_daily_limit(user_id, tier)

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
                if "meta" in event:
                    meta.update(event["meta"])
        except providers.NoProviderAvailable as e:
            AnalyticsService.record_failure(
                operation="enhance_stream", reason="provider_unavailable",
                platform=request.platform, mode=request.mode, user_id=user_id,
            )
            failure = e.user_message
            yield f"data: {json.dumps({'error': failure, 'done': True, 'failed': True})}\n\n"
            return
        except Exception as e:
            failure = "The enhancement service encountered an error. Please try again."
            logger.error(f"❌ Stream failed mid-flight: {e}")
            yield f"data: {json.dumps({'error': failure, 'done': True, 'failed': True})}\n\n"
            return

        enhanced_prompt = "".join(enhanced_parts)
        process_time = round(time.time() - ctx["start_time"], 2)

        log_id = None
        if enhanced_prompt.strip():
            max_similarity = ctx["similar_saved"][0]["score"] if ctx["similar_saved"] else 0.0
            # Always logged; see enhance_prompt for why tracking does not gate this.
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
            # Evaluated off the response, as on /enhance. The stream has no
            # BackgroundTasks to hand off to — the response is already closing —
            # so it keeps the thread.
            if log_id:
                threading.Thread(
                    target=_async_evaluate_prompt,
                    args=(log_id, user_id, request.prompt, enhanced_prompt, ctx.get("conversation_ctx", "") or ""),
                    daemon=True,
                ).start()
            # Generation only creates a prompt log. Memorization happens on /enhance/accept.
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
            "context_used": _context_used(ctx, request),
            "context_details": _context_details(ctx),
            "truncated": meta.get("truncated", False),
        }) + "\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/enhance/accept")
def accept_enhancement(
    request: dict,
    user_id: str = Depends(verify_jwt),
):
    """Approve a server-owned enhancement log and memorize strategy."""
    log_id = request.get("log_id") if isinstance(request, dict) else None
    if not log_id:
        return JSONResponse(
            status_code=422,
            content={"detail": "log_id is required"},
        )
    result = MemoryService.approve_enhancement(user_id, log_id)
    if result is None:
        return JSONResponse(status_code=404, content={"detail": "Enhancement not found"})
    if result.get("status") == "unavailable":
        return JSONResponse(status_code=503, content={"detail": "Store unavailable"})
    return result


@router.post("/enhance/feedback")
def enhance_feedback(request: FeedbackRequest, user_id: str = Depends(verify_jwt)):
    """Store thumbs up/down feedback on an enhanced prompt."""
    feedback_doc = {
        "user_id": user_id,
        "log_id": request.log_id,
        "rating": request.rating,
        "original": request.original,
        "enhanced": request.enhanced,
        "timestamp": time.time(),
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
    history = MemoryService.get_enhance_history(user_id, limit=20)
    return {"history": history}


@router.get("/enhance/usage")
def enhance_usage(byok: bool = False, user_id: str = Depends(verify_jwt)):
    """Returns today's enhancement count for the user."""
    count, degraded = count_today(user_id)
    tier = "byok" if byok else get_user_tier(user_id)
    limit = settings.TIER_LIMITS.get(tier, settings.SHARED_KEY_DAILY_LIMIT)
    if degraded and tier != "byok":
        limit = min(limit, usage.DEGRADED_LIMIT)
    return {"count": count, "limit": limit, "tier": tier, "degraded": degraded}


# ══════════════════════════════════════════════════════════════
# VOICE ENDPOINTS
# ══════════════════════════════════════════════════════════════

def _voice_error(*, status_code: int, reason: str, detail: str, user_id: str, platform: str):
    AnalyticsService.record_failure(
        operation="voice_transcribe", reason=reason,
        platform=platform, user_id=user_id,
    )
    return JSONResponse(status_code=status_code, content={"error": reason, "detail": detail})


def _transcribe_voice_audio(
    *,
    audio: UploadFile,
    platform: str,
    byok_provider: str,
    byok_key: str,
    recording_duration_seconds: float,
    user_id: str,
):
    content_type = (audio.content_type or "").lower()
    if content_type and not (content_type.startswith("audio/") or content_type == "application/octet-stream"):
        return None, _voice_error(
            status_code=415, reason="unsupported_audio_format",
            detail="Use a supported audio recording format.", user_id=user_id, platform=platform,
        )

    audio_bytes = audio.file.read()
    if len(audio_bytes) < 100:
        return None, _voice_error(
            status_code=422, reason="audio_too_short",
            detail="Audio was too short. Speak for at least a second and try again.",
            user_id=user_id, platform=platform,
        )
    if len(audio_bytes) > settings.MAX_AUDIO_BYTES:
        return None, _voice_error(
            status_code=413, reason="audio_too_large",
            detail="Recording is too large. Keep it shorter and try again.",
            user_id=user_id, platform=platform,
        )

    whisper_key = byok_key if (byok_provider or "").lower() == "groq" else None
    filename = audio.filename or "recording.webm"
    started = time.time()

    def request_transcription():
        client = get_groq_client(whisper_key)
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = filename
        return client.audio.transcriptions.create(
            file=(audio_file.name, audio_file),
            model="whisper-large-v3-turbo",
            response_format="verbose_json",
        )

    try:
        transcription = request_transcription()
    except Exception as error:
        if whisper_key is None and ("429" in str(error) or "rate" in str(error).lower()):
            mark_groq_rate_limited()
            try:
                transcription = request_transcription()
            except Exception as retry_error:
                is_rate_limited = "429" in str(retry_error) or "rate" in str(retry_error).lower()
                return None, _voice_error(
                    status_code=429 if is_rate_limited else 503,
                    reason="transcription_rate_limited" if is_rate_limited else "transcription_unavailable",
                    detail=("Voice transcription is busy. Please try again shortly."
                            if is_rate_limited else
                            "Voice transcription is temporarily unavailable. Please try again."),
                    user_id=user_id, platform=platform,
                )
        else:
            return None, _voice_error(
                status_code=503, reason="transcription_unavailable",
                detail="Voice transcription is temporarily unavailable. Please try again.",
                user_id=user_id, platform=platform,
            )

    text, language = _transcription_parts(transcription)
    if len(text) < 3:
        return None, _voice_error(
            status_code=422, reason="transcription_empty",
            detail="Could not understand the recording. Try speaking clearly.",
            user_id=user_id, platform=platform,
        )

    transcription_seconds = round(time.time() - started, 2)
    AnalyticsService.record_voice_transcription(
        user_id=user_id,
        platform=platform,
        duration_seconds=recording_duration_seconds,
        transcription_seconds=transcription_seconds,
        detected_language=language,
    )
    return {
        "transcription": text,
        "detected_language": language,
        "transcription_time": transcription_seconds,
    }, None


@router.post("/voice-transcribe")
def voice_transcribe(
    audio: UploadFile = File(...),
    platform: str = Form("unknown"),
    recording_duration_seconds: float = Form(0),
    byok_provider: str = Form(""),
    byok_key: str = Form(""),
    user_id: str = Depends(voice_limit),
):
    """Return an editable Whisper transcript. Audio is used only for this request."""
    result, error = _transcribe_voice_audio(
        audio=audio, platform=platform, byok_provider=byok_provider,
        byok_key=byok_key, recording_duration_seconds=recording_duration_seconds,
        user_id=user_id,
    )
    return error or result


@router.post("/voice-enhance")
def voice_enhance(
    audio: UploadFile = File(...),
    mode: str = Form("deep"),
    platform: str = Form("unknown"),
    conversation_context: str = Form(""),
    selected_prompt_ids: str = Form("[]"),
    recording_duration_seconds: float = Form(0),
    byok_provider: str = Form(""),
    byok_key: str = Form(""),
    byok_model: str = Form(""),
    user_id: str = Depends(voice_limit),
):
    """Legacy one-shot voice endpoint, retained for existing extension builds."""
    started = time.time()
    transcription, error = _transcribe_voice_audio(
        audio=audio, platform=platform, byok_provider=byok_provider,
        byok_key=byok_key, recording_duration_seconds=recording_duration_seconds,
        user_id=user_id,
    )
    if error:
        return error

    try:
        ctx_list = json.loads(conversation_context) if conversation_context else []
    except Exception:
        ctx_list = []
    try:
        selected_ids = json.loads(selected_prompt_ids) if selected_prompt_ids else []
    except Exception:
        selected_ids = []

    enhance_req = EnhanceRequest(
        prompt=transcription["transcription"], mode=mode, platform=platform,
        conversation_context=ctx_list or None, selected_prompt_ids=selected_ids or None,
        source_language=(transcription["detected_language"]
                         if transcription["detected_language"] != "unknown" else None),
        byok_provider=byok_provider or None, byok_key=byok_key or None,
        byok_model=byok_model or None, input_method="voice",
        input_duration_seconds=recording_duration_seconds,
    )
    enhanced = enhance_prompt(enhance_req, user_id)
    if isinstance(enhanced, JSONResponse):
        return enhanced

    return {
        "transcription": transcription["transcription"],
        "enhanced": enhanced.get("enhanced", transcription["transcription"]),
        "original": transcription["transcription"],
        "mode": mode,
        "detected_language": transcription["detected_language"],
        "transcription_time": transcription["transcription_time"],
        "total_time": round(time.time() - started, 2),
        "context_used": enhanced.get("context_used"),
        "log_id": enhanced.get("log_id", ""),
    }


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
