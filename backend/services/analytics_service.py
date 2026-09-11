"""Private, aggregate-only analytics for the builder dashboard.

This module deliberately never returns prompt text, conversation context,
tokens, emails, or provider keys. Prompt logs remain the source for successful
enhancements; failure events contain only operational metadata.
"""

from __future__ import annotations

import hashlib
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Optional

from ..core.database import (
    MongoDB,
    QdrantDB,
    in_memory_analytics_events,
    in_memory_prompt_logs,
    in_memory_saved_prompts,
    in_memory_users,
)
from ..core.config import settings


def _now() -> datetime:
    return datetime.now()


def _user_hash(user_id: Optional[str]) -> Optional[str]:
    if not user_id:
        return None
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]


def _in_range(value, since: datetime) -> bool:
    return isinstance(value, datetime) and value >= since


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil((percentile / 100) * len(ordered)) - 1)
    return round(float(ordered[max(0, index)]), 3)


class AnalyticsService:
    @staticmethod
    def record_failure(
        *,
        operation: str,
        reason: str,
        platform: Optional[str] = None,
        mode: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> None:
        """Persist safe operational metadata for a failed operation."""
        doc = {
            "event": "failure",
            "operation": operation[:40],
            "reason": reason[:80],
            "platform": (platform or "unknown")[:80],
            "mode": (mode or "unknown")[:30],
            "user_hash": _user_hash(user_id),
            "timestamp": _now(),
        }
        try:
            if MongoDB.analytics_col is not None:
                MongoDB.analytics_col.insert_one(doc)
            else:
                in_memory_analytics_events.append(doc)
        except Exception:
            # Analytics must never make the user-facing enhancement fail.
            in_memory_analytics_events.append(doc)

    @staticmethod
    def record_voice_transcription(
        *,
        user_id: Optional[str],
        platform: Optional[str],
        duration_seconds: Optional[float],
        transcription_seconds: float,
        detected_language: Optional[str],
    ) -> None:
        """Record voice-operation metadata only; audio and transcript stay out."""
        doc = {
            "event": "voice_transcribed",
            "operation": "voice_transcribe",
            "platform": (platform or "unknown")[:80],
            "user_hash": _user_hash(user_id),
            "duration_seconds": round(max(0.0, float(duration_seconds or 0)), 3),
            "transcription_seconds": round(max(0.0, float(transcription_seconds or 0)), 3),
            "language": (detected_language or "unknown")[:20],
            "timestamp": _now(),
        }
        try:
            if MongoDB.analytics_col is not None:
                MongoDB.analytics_col.insert_one(doc)
            else:
                in_memory_analytics_events.append(doc)
        except Exception:
            in_memory_analytics_events.append(doc)

    @staticmethod
    def summary(days: int = 7) -> dict:
        days = max(1, min(int(days), 90))
        since = _now() - timedelta(days=days)
        max_logs = max(1, settings.DASHBOARD_MAX_LOGS)

        logs = []
        if MongoDB.prompts_col is not None:
            projection = {
                # Required for active-user counting. This was accidentally
                # omitted, so Mongo-backed deployments reported zero active
                # users while the in-memory test path appeared correct.
                "user_id": 1,
                "timestamp": 1,
                "source": 1,
                "latency": 1,
                "mode": 1,
                "platform": 1,
                "provider": 1,
                "model": 1,
                "byok": 1,
                "input_method": 1,
                "enhanced": 1,
            }
            try:
                logs = list(MongoDB.prompts_col.find(
                    {"timestamp": {"$gte": since}}, projection
                ).sort("timestamp", -1).limit(max_logs + 1))
            except Exception:
                logs = []
        else:
            logs = sorted(
                (x for x in in_memory_prompt_logs if _in_range(x.get("timestamp"), since)),
                key=lambda x: x.get("timestamp"),
                reverse=True,
            )[:max_logs + 1]

        logs_truncated = len(logs) > max_logs
        logs = logs[:max_logs]

        active = [
            x for x in logs
            if x.get("source", "active") == "active" and x.get("enhanced")
        ]
        passive = [x for x in logs if x.get("source") == "passive_tracker"]
        latencies = [float(x.get("latency") or 0) for x in active if x.get("latency") is not None]

        daily = defaultdict(lambda: {"enhancements": 0, "passive_events": 0})
        modes = Counter()
        platforms = Counter()
        providers = Counter()
        models = Counter()
        input_methods = Counter()
        byok_count = 0
        users = set()

        for item in active:
            day = item["timestamp"].date().isoformat() if isinstance(item.get("timestamp"), datetime) else "unknown"
            daily[day]["enhancements"] += 1
            modes[item.get("mode") or "unknown"] += 1
            platforms[item.get("platform") or "unknown"] += 1
            providers[item.get("provider") or "unknown"] += 1
            models[item.get("model") or "unknown"] += 1
            input_methods[item.get("input_method") or "text"] += 1
            byok_count += bool(item.get("byok"))
            if item.get("user_id"):
                users.add(item["user_id"])

        for item in passive:
            day = item["timestamp"].date().isoformat() if isinstance(item.get("timestamp"), datetime) else "unknown"
            daily[day]["passive_events"] += 1
            if item.get("user_id"):
                users.add(item["user_id"])

        failures = []
        if MongoDB.analytics_col is not None:
            try:
                failures = list(MongoDB.analytics_col.find(
                    {"event": "failure", "timestamp": {"$gte": since}},
                    {"_id": 0, "operation": 1, "reason": 1, "platform": 1,
                     "mode": 1, "timestamp": 1},
                ).sort("timestamp", -1).limit(100))
            except Exception:
                failures = []
        else:
            failures = [
                x for x in in_memory_analytics_events
                if x.get("event") == "failure" and _in_range(x.get("timestamp"), since)
            ][-100:]
            failures.reverse()

        for item in failures:
            day = item["timestamp"].date().isoformat() if isinstance(item.get("timestamp"), datetime) else "unknown"
            daily.setdefault(day, {"enhancements": 0, "passive_events": 0})
            daily[day]["failures"] = daily[day].get("failures", 0) + 1

        voice_transcriptions = 0
        voice_transcription_seconds = []
        if MongoDB.analytics_col is not None:
            try:
                voice_events = MongoDB.analytics_col.find(
                    {"event": "voice_transcribed", "timestamp": {"$gte": since}},
                    {"transcription_seconds": 1},
                )
                for item in voice_events:
                    voice_transcriptions += 1
                    if isinstance(item.get("transcription_seconds"), (int, float)):
                        voice_transcription_seconds.append(float(item["transcription_seconds"]))
            except Exception:
                pass
        else:
            for item in in_memory_analytics_events:
                if item.get("event") != "voice_transcribed" or not _in_range(item.get("timestamp"), since):
                    continue
                voice_transcriptions += 1
                if isinstance(item.get("transcription_seconds"), (int, float)):
                    voice_transcription_seconds.append(float(item["transcription_seconds"]))

        feedback_up = feedback_down = 0
        if MongoDB.db is not None:
            try:
                feedback = MongoDB.db["prompt_feedback"].find(
                    {"timestamp": {"$gte": since}}, {"rating": 1}
                )
                for item in feedback:
                    if item.get("rating") == "up":
                        feedback_up += 1
                    elif item.get("rating") == "down":
                        feedback_down += 1
            except Exception:
                pass

        if MongoDB.users_col is not None:
            try:
                total_users = MongoDB.users_col.count_documents({})
            except Exception:
                total_users = 0
        else:
            total_users = len(in_memory_users)

        if MongoDB.saved_prompts_col is not None:
            try:
                saved_prompts = MongoDB.saved_prompts_col.count_documents({})
            except Exception:
                saved_prompts = 0
        else:
            saved_prompts = len(in_memory_saved_prompts)

        return {
            "generated_at": _now().isoformat(),
            "range": {
                "days": days,
                "since": since.isoformat(),
                "logs_truncated": logs_truncated,
                "max_logs": max_logs,
            },
            "summary": {
                "total_users": total_users,
                "active_users": len(users),
                "enhancements": len(active),
                "passive_events": len(passive),
                "failures": len(failures),
                "saved_prompts": saved_prompts,
                "feedback_up": feedback_up,
                "feedback_down": feedback_down,
                "feedback_total": feedback_up + feedback_down,
                "byok_enhancements": byok_count,
                "voice_enhancements": input_methods.get("voice", 0),
                "voice_transcriptions": voice_transcriptions,
                "voice_transcription_failures": sum(
                    1 for x in failures if x.get("operation") == "voice_transcribe"
                ),
                "avg_voice_transcription_seconds": round(
                    sum(voice_transcription_seconds) / len(voice_transcription_seconds), 3
                ) if voice_transcription_seconds else 0.0,
                "avg_latency_seconds": round(sum(latencies) / len(latencies), 3) if latencies else 0.0,
                "p50_latency_seconds": _percentile(latencies, 50),
                "p95_latency_seconds": _percentile(latencies, 95),
            },
            "daily": [
                {"date": day, **daily[day]}
                for day in sorted(daily)
            ],
            "breakdowns": {
                "modes": dict(modes.most_common()),
                "platforms": dict(platforms.most_common()),
                "providers": dict(providers.most_common()),
                "models": dict(models.most_common()),
                "input_methods": dict(input_methods.most_common()),
            },
            "failures": [
                {
                    "operation": x.get("operation", "unknown"),
                    "reason": x.get("reason", "unknown"),
                    "platform": x.get("platform", "unknown"),
                    "mode": x.get("mode", "unknown"),
                    "timestamp": x.get("timestamp").isoformat() if isinstance(x.get("timestamp"), datetime) else None,
                }
                for x in failures[:25]
            ],
            "system": {
                "mongo_connected": MongoDB.db is not None,
                "qdrant": QdrantDB.health(),
            },
        }
