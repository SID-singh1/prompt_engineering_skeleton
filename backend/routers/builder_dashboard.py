import hmac
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, Response

from ..core.config import settings
from ..services.analytics_service import AnalyticsService
from ..services.llm_service import embedding_status
from ..services.providers import pool_status


router = APIRouter(prefix="/builder/dashboard", tags=["Builder Dashboard"])


def _require_builder_key(value: Optional[str]) -> None:
    configured = settings.BUILDER_DASHBOARD_KEY
    if not configured:
        raise HTTPException(status_code=404, detail="Builder dashboard is disabled.")
    if not value or not hmac.compare_digest(value, configured):
        raise HTTPException(status_code=403, detail="Builder dashboard access denied.")


@router.get("/summary")
def dashboard_summary(
    response: Response,
    days: int = Query(7, ge=1, le=90),
    x_builder_key: Optional[str] = Header(default=None, alias="X-Builder-Key"),
):
    """Return aggregate builder analytics and current system health only."""
    _require_builder_key(x_builder_key)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    payload = AnalyticsService.summary(days)
    payload["system"]["providers"] = pool_status()
    payload["system"]["embedding"] = embedding_status()
    return payload
