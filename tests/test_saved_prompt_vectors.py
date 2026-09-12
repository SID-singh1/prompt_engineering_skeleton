"""
End-to-end behaviour of the saved-prompt vector lifecycle, against a fake
Qdrant that actually stores and removes points.

The unit test in test_point_ids.py proves ids are now stable. That is necessary
but not sufficient: the bug the user experienced was "I deleted a saved prompt
and it kept coming back in my enhancements", and only exercising
embed -> delete together shows that is fixed.

Also covers the case the id fix alone does NOT solve — points written before the
change, whose ids came from a randomised hash and can never be recomputed.
Deletion matches on the mongo_id payload precisely so those are reachable too.
"""

import random

import pytest

from backend.services import memory_service
from backend.services.memory_service import MemoryService, point_id_for


class FakeQdrant:
    """Stores points per collection and honours both selector styles."""

    def __init__(self):
        self.collections = {}

    def upsert(self, collection_name, points):
        store = self.collections.setdefault(collection_name, {})
        for p in points:
            store[p.kwargs["id"]] = p.kwargs["payload"]

    def delete(self, collection_name, points_selector):
        store = self.collections.setdefault(collection_name, {})

        # points_selector is either a FilterSelector or a bare list of ids.
        if isinstance(points_selector, list):
            for pid in points_selector:
                store.pop(pid, None)
            return

        conditions = points_selector.kwargs["filter"].kwargs["must"]
        wanted = {
            c.kwargs["key"]: c.kwargs["match"].kwargs["value"] for c in conditions
        }
        for pid in [
            pid for pid, payload in store.items()
            if all(payload.get(k) == v for k, v in wanted.items())
        ]:
            store.pop(pid)

    def query_points(self, collection_name, query, query_filter=None, limit=10, **kw):
        """Returns every point matching the filter, scored 1.0 — the vector maths
        is not what is under test here, the user_id scoping is."""
        store = self.collections.setdefault(collection_name, {})
        wanted = {}
        if query_filter is not None:
            for c in query_filter.kwargs["must"]:
                wanted[c.kwargs["key"]] = c.kwargs["match"].kwargs["value"]
        points = [
            type("P", (), {"payload": payload, "score": 1.0, "id": pid})()
            for pid, payload in store.items()
            if all(payload.get(k) == v for k, v in wanted.items())
        ]
        return type("R", (), {"points": points[:limit]})()

    def ids(self, collection):
        return set(self.collections.get(collection, {}))


SAVED = "saved_prompt_vectors"
MONGO_ID = "68b9f2c1e4a37d0091ab2f5e"
USER = "user-1"


@pytest.fixture
def qdrant(monkeypatch):
    fake = FakeQdrant()
    monkeypatch.setattr(memory_service.QdrantDB, "get_client", staticmethod(lambda: fake))
    monkeypatch.setattr(memory_service, "get_embedding", lambda text: [0.1] * 384)
    return fake


def test_embed_then_delete_removes_the_vector(qdrant):
    """
    Save a prompt, delete it, and have it actually go.

    Note this is a SANITY check, not the regression test — it passes against
    the buggy code too. `hash()` is stable within a single process, so an
    embed and a delete in the same test agree on the id by accident. The bug
    only bites when the two happen in different processes, which is every real
    deletion: the vector is written on one request and removed days later,
    after at least one restart of a free-tier Space that sleeps when idle.

    The reproductions are
    test_delete_reaches_points_written_under_the_old_random_id_scheme below and
    test_point_ids.py::test_stable_across_processes_with_different_hash_seeds.
    """
    MemoryService.embed_saved_prompt(USER, MONGO_ID, "my saved prompt", "Title", [])
    assert len(qdrant.ids(SAVED)) == 1

    MemoryService.delete_saved_prompt_vector(MONGO_ID, USER)
    assert qdrant.ids(SAVED) == set(), "deleted prompt's vector survived"


def test_re_embedding_after_an_edit_overwrites_rather_than_duplicating(qdrant):
    """
    A randomised id produced a NEW point on every edit, so the stale pre-edit
    text stayed in the index and could outrank the correction.
    """
    MemoryService.embed_saved_prompt(USER, MONGO_ID, "first version", "T", [])
    MemoryService.embed_saved_prompt(USER, MONGO_ID, "second version", "T", [])

    assert len(qdrant.ids(SAVED)) == 1, "editing a prompt left a duplicate behind"
    payload = next(iter(qdrant.collections[SAVED].values()))
    assert payload["content"] == "second version"


def test_delete_reaches_points_written_under_the_old_random_id_scheme(qdrant):
    """
    The self-healing property. This point's id is what the pre-fix code would
    have produced; it can never be recomputed, so an id-based delete could not
    touch it. Matching on payload can.
    """
    legacy_id = random.getrandbits(63)
    qdrant.collections[SAVED] = {
        legacy_id: {"user_id": USER, "mongo_id": MONGO_ID, "content": "orphan"}
    }
    assert legacy_id != point_id_for(MONGO_ID)

    MemoryService.delete_saved_prompt_vector(MONGO_ID, USER)
    assert qdrant.ids(SAVED) == set(), "legacy orphan was not reachable"


def test_delete_is_scoped_to_the_owner(qdrant):
    """One user's delete must not reach another user's vector."""
    MemoryService.embed_saved_prompt("owner", MONGO_ID, "theirs", "", [])
    MemoryService.delete_saved_prompt_vector(MONGO_ID, "someone-else")
    assert len(qdrant.ids(SAVED)) == 1, "deleted another user's vector"

    MemoryService.delete_saved_prompt_vector(MONGO_ID, "owner")
    assert qdrant.ids(SAVED) == set()


def test_delete_leaves_other_prompts_alone(qdrant):
    MemoryService.embed_saved_prompt(USER, MONGO_ID, "keep me", "", [])
    MemoryService.embed_saved_prompt(USER, "68b9f2c1e4a37d0091ab2f5f", "delete me", "", [])

    MemoryService.delete_saved_prompt_vector("68b9f2c1e4a37d0091ab2f5f", USER)

    remaining = list(qdrant.collections[SAVED].values())
    assert len(remaining) == 1 and remaining[0]["content"] == "keep me"


def test_purge_user_vectors_clears_both_collections(qdrant):
    """Backs the deletion right privacy.html promises."""
    MemoryService.embed_saved_prompt(USER, MONGO_ID, "mine", "", [])
    qdrant.collections["prompt_memory"] = {1: {"user_id": USER}, 2: {"user_id": "other"}}

    MemoryService.purge_user_vectors(USER)

    assert qdrant.ids(SAVED) == set()
    assert qdrant.ids("prompt_memory") == {2}, "purged another user's data"


def test_secrets_are_redacted_before_embedding(qdrant):
    """A pasted key must never reach the vector store."""
    MemoryService.embed_saved_prompt(
        USER, MONGO_ID, "deploy with sk-abcdef1234567890ABCDEF now", "", []
    )
    payload = next(iter(qdrant.collections[SAVED].values()))
    assert "sk-abcdef1234567890ABCDEF" not in payload["content"]
    assert "[REDACTED]" in payload["content"]


# ── per-user scoping ──────────────────────────────────────────────────────
# Saved prompts are private. A search that ignored user_id would splice one
# customer's client notes into another's prompt, which is a confidentiality
# failure rather than a bug — and invisible, because the leaked text arrives
# as "context" the user never sees.

def test_search_never_returns_another_users_prompt(qdrant):
    MemoryService.embed_saved_prompt("alice", MONGO_ID, "Alice's client playbook", "Alice", [])
    MemoryService.embed_saved_prompt("bob", "68b9f2c1e4a37d0091ab2f5f", "Bob's checklist", "Bob", [])

    for user, expected in (("alice", "Alice"), ("bob", "Bob")):
        hits = MemoryService.search_saved_prompts(user, "anything at all", limit=10)
        titles = {h["title"] for h in hits}
        assert titles == {expected}, f"{user} saw {titles}"


def test_a_user_with_nothing_saved_sees_nothing(qdrant):
    """
    Asserts the positive case as well, deliberately. A test that only checked
    "the stranger sees nothing" would pass against a completely broken search —
    search_saved_prompts() catches every exception and returns [], so "nothing
    leaked" and "nothing works" are the same observation. The owner's own hit is
    what makes the empty result mean something.
    """
    MemoryService.embed_saved_prompt("alice", MONGO_ID, "Alice's playbook", "Alice", [])

    assert MemoryService.search_saved_prompts("alice", "playbook", limit=10), \
        "search returned nothing for the owner — the isolation check below is vacuous"
    assert MemoryService.search_saved_prompts("stranger", "playbook", limit=10) == []


def test_purge_is_scoped_to_one_user(qdrant):
    MemoryService.embed_saved_prompt("alice", MONGO_ID, "Alice's playbook", "Alice", [])
    MemoryService.embed_saved_prompt("bob", "68b9f2c1e4a37d0091ab2f5f", "Bob's checklist", "Bob", [])

    MemoryService.purge_user_vectors("bob")

    assert {h["title"] for h in MemoryService.search_saved_prompts("alice", "x", limit=10)} == {"Alice"}
    assert MemoryService.search_saved_prompts("bob", "x", limit=10) == []
