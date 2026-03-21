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
    """
    prompt: str
    platform: Optional[str] = "unknown"
    mode: Optional[str] = "deep"  # quick | deep | creative
    conversation_context: Optional[List[str]] = None
    selected_prompt_ids: Optional[List[str]] = None
    source_language: Optional[str] = None  # ISO code from Whisper (e.g., "en", "hi")

class FeedbackRequest(BaseModel):
    """Thumbs up/down on an enhanced prompt."""
    log_id: str
    rating: str  # "up" | "down"
    original: Optional[str] = None
    enhanced: Optional[str] = None

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
