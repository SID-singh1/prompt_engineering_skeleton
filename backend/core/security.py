
import uuid
from datetime import datetime, timedelta
import jwt
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .config import settings

security_scheme = HTTPBearer()

# Anonymous installs get a signed token whose subject carries this prefix.
# Google accounts are uuid4 strings, so the two can never collide, and the
# prefix lets every route tell them apart without a database read.
ANON_PREFIX = "anon_"


def is_anonymous(user_id: str) -> bool:
    return str(user_id or "").startswith(ANON_PREFIX)


def create_jwt_token(user_id: str, email: str) -> str:
    """Creates a signed JWT with 7-day expiration."""
    expiration = datetime.utcnow() + timedelta(days=7)
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expiration
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.ALGORITHM)


def create_anon_token() -> tuple:
    """
    A token for an install that has not signed in. Returns (token, user_id).

    It names no person and nothing is stored against it: it only lets the
    server count one install's free rewrites. No email, so /auth/refresh
    refuses it; when it lapses the extension asks for a new one.
    """
    user_id = f"{ANON_PREFIX}{uuid.uuid4().hex}"
    payload = {
        "sub": user_id,
        "anon": True,
        "exp": datetime.utcnow() + timedelta(days=settings.ANON_TOKEN_DAYS),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.ALGORITHM), user_id


def _decode_subject(credentials: HTTPAuthorizationCredentials) -> str:
    token = credentials.credentials
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except (jwt.InvalidTokenError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid token")


def verify_jwt(credentials: HTTPAuthorizationCredentials = Depends(security_scheme)):
    """
    A signed-in user's id. Anonymous tokens are refused here, so every route
    that keeps data (library, history, feedback, voice) needs an account
    without each one having to remember to check.
    """
    user_id = _decode_subject(credentials)
    if is_anonymous(user_id):
        raise HTTPException(status_code=403, detail="sign_in_required")
    return user_id


def verify_jwt_or_anon(credentials: HTTPAuthorizationCredentials = Depends(security_scheme)):
    """A signed-in or anonymous id. Only for the free rewrite and its usage count."""
    return _decode_subject(credentials)
