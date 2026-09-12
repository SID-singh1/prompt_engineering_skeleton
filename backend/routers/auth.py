
import time
import uuid
import secrets
import httpx
import jwt
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import HTMLResponse
from ..models.schemas import RefreshRequest
from ..core.config import settings
from ..core.database import MongoDB, in_memory_users
from ..core.security import create_jwt_token

router = APIRouter()
_oauth_state_store = {}   # state -> expiry.  CSRF protection for OAuth.

# state -> (expiry, payload). Holds a completed sign-in for the few seconds
# between Google redirecting the browser and the extension collecting it.
#
# The old design had the callback page do
# `window.opener.postMessage(payload, "*")` and the extension popup listen for
# it. That could not work from the toolbar: an MV3 action popup is destroyed
# the moment it loses focus, so opening a sign-in window tore down the very
# listener meant to receive the token — and the "*" target origin meant the JWT
# was broadcast to whatever page happened to be the opener, with the receiver
# doing no event.origin check at all.
#
# Now nothing is broadcast. The extension's service worker — which outlives the
# popup — polls /auth/google/poll with the state it started the flow with, and
# the entry is handed over exactly once. state is 32 bytes of secrets.token_
# urlsafe, so it is not guessable, and it expires either way.
_pending_tokens = {}
_PENDING_TTL = 600          # seconds
_MAX_PENDING = 500          # bound the store against a flood of dead flows
_MAX_STATES = 2000          # same bound for states that never complete a flow


def _sweep(store: dict):
    now = time.time()
    for k in [k for k, v in store.items() if (v[0] if isinstance(v, tuple) else v) < now]:
        store.pop(k, None)


# --- GOOGLE OAUTH ---

@router.get("/auth/google/login")
def google_login():
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Server missing Google Client ID")
    
    # Generate CSRF state token
    _sweep(_oauth_state_store)
    _sweep(_pending_tokens)

    # This endpoint is unauthenticated by necessity — it is what you call before
    # you have a token — and the per-user rate limiter cannot cover it for the
    # same reason. Each call previously added an entry that lived for ten
    # minutes with nothing bounding the total, so anyone could grow this dict
    # for as long as they cared to. _pending_tokens has had a cap since it was
    # written; this one was missed.
    if len(_oauth_state_store) >= _MAX_STATES:
        raise HTTPException(
            status_code=503,
            detail="Too many sign-ins in progress. Please try again in a minute.",
        )

    state = secrets.token_urlsafe(32)
    _oauth_state_store[state] = time.time() + _PENDING_TTL
    
    redirect_uri = settings.GOOGLE_REDIRECT_URI
    scope = "openid email profile"
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"response_type=code&client_id={settings.GOOGLE_CLIENT_ID}&"
        f"redirect_uri={redirect_uri}&scope={scope}&"
        f"access_type=offline&prompt=consent&state={state}"
    )
    # `state` is returned so the caller can poll for the result of this exact
    # flow. It is a correlation handle, not a credential: possession of it only
    # lets you collect a token that Google issued for a sign-in you started.
    return {"url": auth_url, "state": state}

@router.get("/auth/google/callback")
async def google_callback(code: str, state: str = ""):
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
         raise HTTPException(status_code=500, detail="Server missing Google Secrets")

    # Validate CSRF state. No longer optional: the extension always sends one,
    # and accepting a stateless callback left the flow forgeable.
    expires = _oauth_state_store.pop(state, None)
    if expires is None or time.time() > expires:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state. Try again.")

    _sweep(_oauth_state_store)
    _sweep(_pending_tokens)

    token_url = "https://oauth2.googleapis.com/token"
    payload = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
    }
    
    async with httpx.AsyncClient() as client:
        res = await client.post(token_url, data=payload)
        if res.status_code != 200:
            return {"error": "Failed to exchange code", "details": res.text}
        
        tokens = res.json()
        access_token = tokens.get("access_token")
        
        user_res = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"}
        )
        user_info = user_res.json()
        
    email = user_info.get("email")
    if not email:
        return {"error": "No email found in Google Account"}
        
    # Find/Create User
    user_id = None
    if MongoDB.users_col is not None:
        user = MongoDB.users_col.find_one({"email": email})
        if user: user_id = user["user_id"]
    else:
        for uid, profile in in_memory_users.items():
            if profile.get("email") == email:
                user_id = uid
                break
                
    if not user_id:
        user_id = str(uuid.uuid4())
        new_profile = {"user_id": user_id, "email": email, "tech_stack": ["General"], "preferences": "Default"}
        if MongoDB.users_col is not None:
            MongoDB.users_col.insert_one(new_profile)
        else:
            in_memory_users[user_id] = new_profile

    token = create_jwt_token(user_id, email)

    # Park the result for the extension's service worker to collect. Nothing is
    # posted to the page, so no origin can intercept it.
    if len(_pending_tokens) < _MAX_PENDING:
        _pending_tokens[state] = (
            time.time() + _PENDING_TTL,
            {"token": token, "email": email, "user_id": user_id},
        )

    return HTMLResponse(content="""
    <html>
      <head><meta charset="utf-8"><title>Signed in</title></head>
      <body style="font-family:system-ui,sans-serif;text-align:center;padding:56px 24px">
        <h2 style="margin:0 0 8px">Signed in</h2>
        <p style="color:#555;margin:0">You can close this tab and go back to Prompt Memory.</p>
        <!-- Deliberately does NOT self-close. The extension's service worker
             treats a vanished tab as "the user cancelled", and a page that
             closed itself before the worker's next poll would race that check
             and report a cancellation for a sign-in that actually succeeded.
             The worker closes this tab once it has the token. -->
      </body>
    </html>
    """)


@router.get("/auth/google/poll")
def google_poll(state: str):
    """
    Collect the result of a sign-in started with this `state`.

    Returns {"status": "pending"} until Google's redirect has landed, then the
    token exactly once. Called by the extension's service worker, which — unlike
    the action popup — survives the user clicking away to complete the flow.
    """
    _sweep(_pending_tokens)
    entry = _pending_tokens.pop(state, None)
    if entry is None:
        return {"status": "pending"}
    return {"status": "ready", **entry[1]}


# --- TOKEN REFRESH ---

@router.post("/auth/refresh")
def refresh_token(request: RefreshRequest):
    """
    Refresh a JWT token if it's still valid but nearing expiry (< 2 days remaining).
    Returns a fresh token with a new 7-day expiry.
    """
    try:
        payload = jwt.decode(request.token, settings.JWT_SECRET, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        email = payload.get("email")
        
        if not user_id or not email:
            raise HTTPException(status_code=400, detail="Invalid token payload")
        
        new_token = create_jwt_token(user_id, email)
        return {"token": new_token, "email": email, "user_id": user_id}
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token already expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
