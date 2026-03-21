
from pymongo import MongoClient
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, Distance
from .config import settings

# MongoDB
class MongoDB:
    client: MongoClient = None
    db = None
    users_col = None
    prompts_col = None
    saved_prompts_col = None
    feedback_col = None
    
    @classmethod
    def connect(cls):
        try:
            cls.client = MongoClient(
                settings.MONGO_URI or "mongodb://localhost:27017",
                serverSelectionTimeoutMS=3000,
            )
            cls.client.admin.command("ping")
            cls.db = cls.client["prompt_engine_db"]
            cls.users_col = cls.db["users"]
            cls.prompts_col = cls.db["prompt_logs"]
            cls.saved_prompts_col = cls.db["saved_prompts"]
            cls.feedback_col = cls.db["user_feedback"]

            # Indexes
            cls.users_col.create_index("user_id", unique=True)
            cls.prompts_col.create_index([("user_id", 1), ("timestamp", -1)])
            cls.saved_prompts_col.create_index("user_id")
            cls.feedback_col.create_index([("user_id", 1), ("timestamp", -1)])
            
            print("✅ MongoDB Indexes Verified")
            print("✅ MongoDB Connected")
        except Exception as e:
            print(f"⚠️ MongoDB not available ({e}) — using in-memory fallback.")
            cls.users_col = None
            cls.prompts_col = None
            cls.saved_prompts_col = None
            cls.feedback_col = None

# Qdrant
class QdrantDB:
    client: QdrantClient = None
    _collections_ready = False
    
    SAVED_COLLECTION = "saved_prompt_vectors"
    
    @classmethod
    def get_client(cls):
        if cls.client is None:
            try:
                cls.client = QdrantClient(url=settings.QDRANT_URL, api_key=settings.QDRANT_API_KEY)
                print(f"✅ Qdrant Connected ({settings.QDRANT_URL})")
            except Exception as e:
                print(f"❌ Qdrant Connection Failed: {e}")
                return None
        
        # Ensure collections exist (runs once per process)
        if not cls._collections_ready and cls.client is not None:
            cls._ensure_collection(settings.COLLECTION_NAME)
            cls._ensure_collection(cls.SAVED_COLLECTION)
            cls._collections_ready = True
        
        return cls.client

    @classmethod
    def _ensure_collection(cls, name: str):
        """Create a 384-dim cosine collection if it doesn't exist, with user_id index."""
        try:
            cls.client.get_collection(name)
            print(f"✔ Qdrant collection '{name}' ready")
        except Exception:
            # Collection doesn't exist — create it
            try:
                cls.client.create_collection(
                    collection_name=name,
                    vectors_config=VectorParams(size=384, distance=Distance.COSINE),
                )
                print(f"✅ Created Qdrant collection: '{name}'")
            except Exception as e:
                print(f"⚠️ Could not create collection '{name}': {e}")
                return
        
        try:
            cls.client.create_payload_index(
                collection_name=name,
                field_name="user_id",
                field_schema="keyword"
            )
        except Exception:
            pass

# In-Memory Fallbacks
in_memory_users = {}
in_memory_prompt_logs = []
in_memory_saved_prompts = {}  # {prompt_id: {doc}}
