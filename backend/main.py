
import time as _time
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .core.config import settings
from .core.database import MongoDB, QdrantDB
from .routers import auth, users, prompts, saved_prompts, feedback, builder_dashboard, voice, user_analytics
from backend.core.logger import logger


app = FastAPI(
    title="Context-Aware Prompt Engine",
    # /docs and /openapi.json enumerated all 17 routes to anonymous callers on a
    # publicly reachable Space. Opt back in with ENABLE_DOCS=1.
    docs_url="/docs" if (settings.ENABLE_DOCS or not settings.is_production) else None,
    redoc_url=None,
    openapi_url="/openapi.json" if (settings.ENABLE_DOCS or not settings.is_production) else None,
)


# ── BODY SIZE LIMIT ──
# Runs before routing, so an oversized body is refused without being parsed and
# without waiting for the auth dependency to reject it.
@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    path = request.url.path
    cap = (settings.MAX_AUDIO_BYTES
           if path.startswith(settings.LARGE_BODY_ROUTES)
           else settings.MAX_REQUEST_BYTES)

    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > cap:
                return JSONResponse(
                    status_code=413,
                    content={
                        "error": "payload_too_large",
                        "detail": f"Request body exceeds {cap} bytes.",
                    },
                )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"error": "bad_content_length"},
            )
    return await call_next(request)

# ── REQUEST LOGGING MIDDLEWARE ──
# Prints every request to the terminal so you can see what's being hit
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = _time.time()
    method = request.method
    path = request.url.path
    origin = request.headers.get("origin", "direct")

    logger.info(f"\n{'='*60}")
    logger.info(f"📥 {method} {path}")
    logger.info(f"   Origin: {origin}")

    try:
        response = await call_next(request)
        duration = round((_time.time() - start) * 1000)
        status = response.status_code

        emoji = "✅" if status < 400 else "⚠️" if status < 500 else "❌"
        logger.info(f"   {emoji} Status: {status}  |  ⏱ {duration}ms")
        logger.info(f"{'='*60}")
        return response
    except Exception as e:
        duration = round((_time.time() - start) * 1000)
        logger.error(f"   ❌ ERROR: {e}  |  ⏱ {duration}ms")
        logger.info(f"{'='*60}")
        raise

# CORS — environment-aware (dev: allow all, prod: whitelist only)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── PRIVATE NETWORK ACCESS (development only) ──
#
# Registered AFTER CORSMiddleware deliberately. Starlette applies middleware in
# reverse registration order, so the last one added is the outermost; declared
# before CORS, this never ran at all, because CORSMiddleware answers the
# preflight itself and short-circuits everything inside it.
# Chrome blocks requests from a public origin (chatgpt.com, claude.ai) to a
# loopback address unless the server explicitly opts in on the preflight. That
# is exactly the shape of "extension running on a real site, talking to a
# backend on this laptop", so without this a local backend is unreachable from
# the content script and the failure looks like a generic network error.
#
# Guarded to development: in production the backend is not on a private network
# and advertising this would be meaningless at best.
if not settings.is_production:
    @app.middleware("http")
    async def allow_private_network(request: Request, call_next):
        if (request.method == "OPTIONS"
                and request.headers.get("access-control-request-private-network") == "true"):
            from fastapi.responses import Response
            return Response(status_code=200, headers={
                "Access-Control-Allow-Private-Network": "true",
                "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "600",
            })
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response



# Startup Events
@app.on_event("startup")
def startup_db_client():
    # Safety checks (blocks startup if JWT_SECRET is default in production)
    settings.validate()

    MongoDB.connect()
    # Pre-load embedding model to eliminate first-request cold start
    try:
        from .services.llm_service import preload_embedding_model
        preload_embedding_model()
    except Exception as e:
        logger.warning(f"⚠️ Embedding preload skipped: {e}")

    env_label = "🔧 DEVELOPMENT" if not settings.is_production else "🚀 PRODUCTION"
    cors_label = "* (all origins)" if not settings.is_production else ", ".join(settings.cors_origins) or "(none configured!)"
    logger.info(f"\n{'='*60}")
    logger.info(f"🚀 Prompt Memory v4.0 — Server Ready!")
    logger.info(f"   Environment: {env_label}")
    logger.info(f"   CORS Origins: {cors_label}")
    logger.info(f"   http://localhost:8000")
    logger.info(f"   Docs: http://localhost:8000/docs")
    logger.info(f"{'='*60}\n")

@app.on_event("shutdown")
def shutdown_clients():
    """Release the pooled HTTP connections to the LLM providers."""
    try:
        from .services.providers import close_http_client
        close_http_client()
    except Exception as e:
        logger.warning(f"⚠️ HTTP client shutdown: {e}")


@app.get("/")
def health_check():
    # `environment` is reported so production mode is verifiable from outside.
    # Whether hardening is active was previously unobservable: the only visible
    # symptom of it being off was CORS quietly accepting every origin, which is
    # precisely the thing nobody thinks to check.
    return {
        "status": "running",
        "service": "Context-Aware Prompt Engine",
        "version": "4.1",
        "environment": "production" if settings.is_production else "development",
        "cors_origins": len(settings.cors_origins),
    }


@app.get("/health/llm")
def llm_health():
    """
    Provider and model-chain health.

    Exists because the 2026-08 outage was invisible: a decommissioned model
    returned 404, the handler swallowed it, and /enhance kept answering 200.
    Any model that 404s is recorded in dead_models here, so the next failure of
    that kind is one HTTP call away from being diagnosed.
    """
    from .services.providers import pool_status
    from .services.llm_service import embedding_status
    status = pool_status()

    # Saved-prompt search and passive memory both depend on this, and both fail
    # silently without it: nothing is written, nothing matches, nothing logs.
    status["embedding"] = embedding_status()

    # The other half of the saved-prompt path. Both have to work, and both
    # failed silently before they were reported here.
    status["vector_store"] = QdrantDB.health()
    status["healthy"] = bool(status["chain"]) and any(
        p["keys_configured"] > 0 for p in status["providers"].values()
    )
    return status

# Include Routers
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(prompts.router)
app.include_router(saved_prompts.router)
app.include_router(feedback.router)
app.include_router(builder_dashboard.router)
app.include_router(voice.router)
app.include_router(user_analytics.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
