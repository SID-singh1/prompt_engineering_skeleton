"""Approval, ownership and retry behavior for long-term passive memory."""

from backend.core.database import MongoDB
from backend.services import memory_service
from backend.services.memory_service import MemoryService


class FakePrompts:
    def __init__(self):
        self.docs = {}
        self.fail_update = False

    def insert_one(self, doc):
        self.docs[doc["log_id"]] = dict(doc)

    def find_one(self, query):
        return next((dict(doc) for doc in self.docs.values()
                     if all(doc.get(key) == value for key, value in query.items())), None)

    def update_one(self, query, update):
        if self.fail_update:
            raise RuntimeError("store unavailable")
        doc = self.docs[query["log_id"]]
        doc.update(update["$set"])


class FakeQdrant:
    def __init__(self):
        self.points = {}
        self.fail = False

    def upsert(self, collection_name, points):
        if self.fail:
            raise RuntimeError("vector store unavailable")
        for point in points:
            self.points[point.kwargs["id"]] = point.kwargs["payload"]


def test_persisted_approval_is_scoped_idempotent_and_retryable(monkeypatch):
    prompts = FakePrompts()
    vectors = FakeQdrant()
    monkeypatch.setattr(MongoDB, "prompts_col", prompts)
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)

    log_id = MemoryService.log_prompt("alice", "make a plan", "Create a concise plan.")
    assert len(log_id) == 32
    assert vectors.points == {}
    assert MemoryService.approve_enhancement("bob", log_id) is None
    assert MemoryService.approve_enhancement("alice", "unknown") is None
    assert vectors.points == {}

    vectors.fail = True
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "accepted", "memory_saved": False,
    }
    assert prompts.docs[log_id]["accepted_at"]
    assert vectors.points == {}

    vectors.fail = False
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "accepted", "memory_saved": True,
    }
    assert MemoryService.approve_enhancement("alice", log_id)["memory_saved"] is True
    assert len(vectors.points) == 1
    assert next(iter(vectors.points.values()))["approved"] is True


def test_approval_state_must_be_recorded_before_a_vector_write(monkeypatch):
    prompts = FakePrompts()
    vectors = FakeQdrant()
    monkeypatch.setattr(MongoDB, "prompts_col", prompts)
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)
    log_id = MemoryService.log_prompt("alice", "draft", "Rewrite the draft.")
    prompts.fail_update = True
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "unavailable", "memory_saved": False,
    }
    assert vectors.points == {}


def test_accepted_near_duplicate_is_not_memorized(monkeypatch):
    prompts = FakePrompts()
    vectors = FakeQdrant()
    monkeypatch.setattr(MongoDB, "prompts_col", prompts)
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)
    log_id = MemoryService.log_prompt("alice", "draft", "Rewrite the draft.", score=0.95)
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "accepted", "memory_saved": False,
    }
    assert vectors.points == {}


def test_in_memory_approval_is_owner_scoped_and_idempotent(monkeypatch):
    vectors = FakeQdrant()
    monkeypatch.setattr(MongoDB, "prompts_col", None)
    monkeypatch.setattr(memory_service.settings, "MONGO_URI", "")
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)
    monkeypatch.setattr(memory_service, "in_memory_prompt_logs", [])

    log_id = MemoryService.log_prompt("alice", "draft", "Rewrite the draft.")
    assert MemoryService.approve_enhancement("bob", log_id) is None
    assert vectors.points == {}
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "accepted", "memory_saved": True,
    }
    assert MemoryService.approve_enhancement("alice", log_id)["memory_saved"] is True
    assert len(vectors.points) == 1


def test_configured_but_disconnected_mongo_does_not_leave_orphan_vector(monkeypatch):
    vectors = FakeQdrant()
    monkeypatch.setattr(MongoDB, "prompts_col", None)
    monkeypatch.setattr(memory_service.settings, "MONGO_URI", "mongodb://fixture")
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)
    monkeypatch.setattr(memory_service, "in_memory_prompt_logs", [])
    log_id = MemoryService.log_prompt("alice", "draft", "Rewrite the draft.")
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "unavailable", "memory_saved": False,
    }
    assert vectors.points == {}


def test_failed_mongo_insert_still_has_retryable_history(monkeypatch):
    class FailingPrompts:
        def __init__(self):
            self.available = False
            self.docs = {}

        def insert_one(self, doc):
            if not self.available:
                raise RuntimeError("database temporarily unavailable")
            self.docs[doc["log_id"]] = dict(doc)

        def find_one(self, query):
            return next((dict(doc) for doc in self.docs.values()
                         if all(doc.get(key) == value for key, value in query.items())), None)

        def find(self, query):
            raise RuntimeError("database temporarily unavailable")

        def update_one(self, query, update):
            self.docs[query["log_id"]].update(update["$set"])

    vectors = FakeQdrant()
    prompts = FailingPrompts()
    monkeypatch.setattr(MongoDB, "prompts_col", prompts)
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: vectors))
    monkeypatch.setattr(memory_service, "get_embedding", lambda _: [0.1] * 384)
    monkeypatch.setattr(memory_service, "in_memory_prompt_logs", [])

    log_id = MemoryService.log_prompt("alice", "draft", "Rewrite the draft.")
    assert [item["log_id"] for item in MemoryService.get_enhance_history("alice")] == [log_id]
    assert MemoryService.get_enhance_history("bob") == []
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "unavailable", "memory_saved": False,
    }
    assert vectors.points == {}
    prompts.available = True
    assert MemoryService.approve_enhancement("alice", log_id) == {
        "status": "accepted", "memory_saved": True,
    }
    assert prompts.docs[log_id]["accepted_at"]
