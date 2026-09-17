import io
import time
import json
from fastapi import APIRouter, Depends, UploadFile, File, Form
from fastapi.responses import JSONResponse
from ..models.schemas import EnhanceRequest
from ..core.config import settings
from ..core.ratelimit import voice_limit
from ..services.analytics_service import AnalyticsService
from ..services.llm_service import get_groq_client, mark_groq_rate_limited
from ..services.prompt_builder import LANGUAGE_NAMES

# Needs to be imported inside the route or at top if no circular dependency
from .prompts import enhance_prompt

router = APIRouter()

def _voice_error(*, status_code: int, reason: str, detail: str, user_id: str, platform: str):
    AnalyticsService.record_failure(
        operation="voice_transcribe", reason=reason,
        platform=platform, user_id=user_id,
    )
    return JSONResponse(status_code=status_code, content={"error": reason, "detail": detail})

def _transcription_parts(transcription) -> tuple[str, str]:
    if hasattr(transcription, "text"):
        text = transcription.text or ""
    elif isinstance(transcription, dict):
        text = transcription.get("text", "")
    else:
        text = str(transcription)

    if hasattr(transcription, "language"):
        language = transcription.language or "unknown"
    elif isinstance(transcription, dict):
        language = transcription.get("language", "unknown")
    else:
        language = "unknown"

    if language == "ur":
        language = "hi"
    elif language not in LANGUAGE_NAMES:
        language = "unknown"
    return text.strip(), language

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
