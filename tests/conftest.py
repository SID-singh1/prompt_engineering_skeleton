"""
Shared test setup.

The backend imports sentence-transformers, groq and qdrant-client at module
scope. Pulling torch into a test run to check a regex is not worth the minutes
it costs, so the heavy third-party modules are stubbed before any backend
import happens. Everything under test here is our own logic.
"""

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _stub(name: str, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules.setdefault(name, mod)
    return mod


class _Any:
    """Stands in for a class we only need to be importable and constructible."""
    def __init__(self, *a, **kw):
        self.args, self.kwargs = a, kw


class _FakeVector(list):
    def tolist(self):
        return list(self)


class _FakeEncoder:
    """
    Deterministic stand-in for the MiniLM encoder.

    get_embedding() calls .encode(...).tolist(), and code paths under test reach
    it through _build_enhance_context. The vectors only have to be the right
    shape and stable for the same input — nothing here asserts on similarity.
    """
    def __init__(self, *a, **kw):
        pass

    def encode(self, text, **kw):
        seed = sum(ord(c) for c in str(text)) or 1
        return _FakeVector(((seed * (i + 1)) % 1000) / 1000.0 for i in range(384))


# sentence-transformers (drags in torch)
_stub("sentence_transformers", SentenceTransformer=_FakeEncoder)

# groq
_stub("groq", Groq=_Any)

# qdrant-client
_stub("qdrant_client", QdrantClient=_Any)
class _VectorParams:
    """Carries .size, which the provisioning code reads back."""
    def __init__(self, size=None, distance=None, **kw):
        self.size = size
        self.distance = distance


class _Distance:
    COSINE = "Cosine"
    EUCLID = "Euclid"
    DOT = "Dot"


_stub(
    "qdrant_client.models",
    PointStruct=_Any, Filter=_Any, FieldCondition=_Any, MatchValue=_Any,
    FilterSelector=_Any, VectorParams=_VectorParams, Distance=_Distance,
)
