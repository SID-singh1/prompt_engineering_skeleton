from pydantic import BaseModel
from typing import Optional, List

class ProfileUpdate(BaseModel):
    tech_stack: Optional[list] = None
    preferences: Optional[str] = None

class UserProfile(BaseModel):
    user_id: str
    email: Optional[str] = None
    tech_stack: Optional[list] = None
    preferences: Optional[str] = None

class SavedPromptCreate(BaseModel):
    content: str
    tags: Optional[list] = None
    title: Optional[str] = None
    platform: Optional[str] = None

class SavedPromptUpdate(BaseModel):
    content: Optional[str] = None
    tags: Optional[list] = None
    title: Optional[str] = None

class TrackRequest(BaseModel):
    """Sent from the extension every time the user submits a prompt on any platform."""
    user_id: str
    prompt: str
    platform: Optional[str] = None

class MemorizeRequest(BaseModel):
    """Manually save a prompt to memory (Qdrant)."""
    user_id: str
    prompt: str

class EnhanceRequest(BaseModel):
    """
    The main enhance endpoint payload.
    - conversation_context: recent messages from the visible chat (scraped from DOM)
    - mode: 'quick' | 'deep' | 'creative' — controls enhancement intensity
    - selected_prompt_ids: IDs of saved prompts the user explicitly ticked
    - excluded_prompt_ids: saved prompts the user asked not to use
    """
    prompt: str
    platform: Optional[str] = "unknown"
    mode: Optional[str] = "deep"  # quick | deep | creative
    conversation_context: Optional[List[str]] = None
    selected_prompt_ids: Optional[List[str]] = None
    # Auto-matched saved prompts the user dropped from the card ("don't use").
    excluded_prompt_ids: Optional[List[str]] = None
    source_language: Optional[str] = None  # ISO code from Whisper (e.g., "en", "hi")
    tracking_enabled: Optional[bool] = True

    # Input metadata is deliberately separate from the prompt body. It lets the
    # private builder dashboard measure voice reliability without retaining an
    # audio file or exposing transcript content.
    input_method: Optional[str] = "text"  # "text" | "voice"
    input_duration_seconds: Optional[float] = None

    # BYOK — the user's own provider key, forwarded per request and never
    # persisted server-side. Sending it here (rather than storing it) means a
    # database breach cannot leak anyone's provider credentials.
    byok_provider: Optional[str] = None   # "groq" | "gemini" | "openrouter"
    byok_key: Optional[str] = None
    byok_model: Optional[str] = None

class FeedbackRequest(BaseModel):
    """Thumbs up/down on an enhanced prompt."""
    log_id: str
    rating: str  # "up" | "down"
    original: Optional[str] = None
    enhanced: Optional[str] = None


class AcceptEnhancementRequest(BaseModel):
    """Approve one server-owned enhancement for passive personalization."""
    log_id: str

class RefreshRequest(BaseModel):
    token: str

class UserFeedbackRequest(BaseModel):
    """General user feedback / bug report (not prompt-level feedback)."""
    type: str  # "bug" | "feature" | "general"
    message: str
    email: Optional[str] = None
    source: Optional[str] = "extension"  # "extension" | "website"
    page_url: Optional[str] = None
    browser_info: Optional[str] = None

class PromptEvaluationRequest(BaseModel):
    original_prompt: str
    enhanced_prompt: str
    extracted_context: Optional[str] = None
    selected_context: Optional[str] = None
    conversation_context: Optional[str] = None
    mode: Optional[str] = "deep"

