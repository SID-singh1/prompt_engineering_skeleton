
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
_oauth_state_store = {}  # CSRF protection for OAuth


# --- GOOGLE OAUTH ---

@router.get("/auth/google/login")
def google_login():
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Server missing Google Client ID")
    
    # Generate CSRF state token
    state = secrets.token_urlsafe(32)
    _oauth_state_store[state] = time.time() + 600  # 10 minute expiry
    
    redirect_uri = settings.GOOGLE_REDIRECT_URI
    scope = "openid email profile"
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"response_type=code&client_id={settings.GOOGLE_CLIENT_ID}&"
        f"redirect_uri={redirect_uri}&scope={scope}&"
        f"access_type=offline&prompt=consent&state={state}"
    )
    return {"url": auth_url}

@router.get("/auth/google/callback")
async def google_callback(code: str, state: str = ""):
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
         raise HTTPException(status_code=500, detail="Server missing Google Secrets")

    # Validate CSRF state (skip if empty for backwards compat)
    if state:
        expires = _oauth_state_store.pop(state, None)
        if expires is None or time.time() > expires:
            raise HTTPException(status_code=400, detail="Invalid or expired OAuth state. Try again.")
    
    # Clean up expired states
    now = time.time()
    expired_states = [s for s, exp in _oauth_state_store.items() if now > exp]
    for s in expired_states:
        _oauth_state_store.pop(s, None)

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
    
    html_content = f"""
    <html>
    <body>
    <script>
        if (window.opener) {{
            window.opener.postMessage({{ type: "GOOGLE_AUTH_SUCCESS", token: "{token}", email: "{email}", user_id: "{user_id}" }}, "*");
            window.close();
        }} else {{
            document.write("Login Successful! You can close this tab.");
        }}
    </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)


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
