"""
Resilience of the vector-store connection.

Every case here corresponds to a real behaviour that produced a months-long,
completely invisible outage: the saved-prompt library saved correctly and
silently never matched anything, because a dead cluster and an empty result set
were indistinguishable at every layer.
"""

import time

import pytest

from backend.core import database
from backend.core.database import QdrantDB
from backend.core.config import settings


class FakeCollectionInfo:
    def __init__(self, size=384):
        self.config = type("c", (), {"params": type("p", (), {
            "vectors": type("v", (), {"size": size})()
        })()})()
        self.points_count = 0
        self.status = "green"


class FakeClient:
    """A cluster whose reachability and behaviour can be switched at will."""

    def __init__(self, reachable=True, existing=(), size=384, create_fails=False):
        self.reachable = reachable
        self.existing = dict.fromkeys(existing, size)
        self.size = size
        self.create_fails = create_fails
        self.created = []

    def _check(self):
        if not self.reachable:
            raise ConnectionError("[Errno 104] Connection reset by peer")

    def get_collections(self):
        self._check()
        return type("r", (), {"collections": []})()

    def get_collection(self, name):
        self._check()
        if name not in self.existing:
            raise ValueError(f"collection {name} not found")
        return FakeCollectionInfo(self.existing[name])

    def create_collection(self, collection_name, vectors_config):
        self._check()
        if self.create_fails:
            raise RuntimeError("quota exceeded")
        self.existing[collection_name] = vectors_config.size
        self.created.append(collection_name)

    def create_payload_index(self, **kw):
        self._check()


@pytest.fixture(autouse=True)
def _reset():
    QdrantDB.reset()
    QdrantDB._last_error = None
    yield
    QdrantDB.reset()
    QdrantDB._last_error = None


def _install(monkeypatch, client):
    monkeypatch.setattr(database, "QdrantClient", lambda **kw: client)
    return client


def test_unreachable_cluster_returns_none_not_a_broken_client(monkeypatch):
    """
    The core defect. QdrantClient does not dial on construction, so a deleted or
    suspended cluster still produced a client object and a "Connected" log line,
    and every later call failed into a handler that returned an empty list.
    """
    _install(monkeypatch, FakeClient(reachable=False))
    assert QdrantDB.get_client() is None
    assert "Connection reset" in (QdrantDB._last_error or "")


def test_reachable_cluster_provisions_both_collections(monkeypatch):
    client = _install(monkeypatch, FakeClient(reachable=True))
    assert QdrantDB.get_client() is client
    assert set(client.created) == {settings.COLLECTION_NAME, QdrantDB.SAVED_COLLECTION}
    assert QdrantDB._collections_ready is True


def test_failed_provisioning_does_not_latch_ready(monkeypatch):
    """
    _collections_ready was set unconditionally, so a single failed startup left
    the collections uncreated for the entire life of the process.
    """
    _install(monkeypatch, FakeClient(reachable=True, create_fails=True))
    QdrantDB.get_client()
    assert QdrantDB._collections_ready is False


def test_provisioning_is_retried_after_a_failure(monkeypatch):
    failing = _install(monkeypatch, FakeClient(reachable=True, create_fails=True))
    QdrantDB.get_client()
    assert QdrantDB._collections_ready is False

    failing.create_fails = False          # cluster recovers
    QdrantDB.get_client()
    assert QdrantDB._collections_ready is True


def test_dimension_mismatch_is_refused_loudly(monkeypatch):
    """
    A collection built for a different embedding width rejects every upsert, and
    the symptom is once again "search returns nothing".
    """
    _install(monkeypatch, FakeClient(
        reachable=True, existing=[settings.COLLECTION_NAME, QdrantDB.SAVED_COLLECTION], size=768,
    ))
    QdrantDB.get_client()
    assert QdrantDB._collections_ready is False
    assert "dim" in (QdrantDB._last_error or "")


def test_matching_dimensions_are_accepted(monkeypatch):
    _install(monkeypatch, FakeClient(
        reachable=True, existing=[settings.COLLECTION_NAME, QdrantDB.SAVED_COLLECTION], size=384,
    ))
    assert QdrantDB.get_client() is not None
    assert QdrantDB._collections_ready is True


def test_failed_connections_back_off_instead_of_hammering(monkeypatch):
    """Retrying on every request would hammer a struggling cluster."""
    client = _install(monkeypatch, FakeClient(reachable=False))
    calls = []
    monkeypatch.setattr(database, "QdrantClient",
                        lambda **kw: (calls.append(1), client)[1])

    for _ in range(5):
        assert QdrantDB.get_client() is None
    assert len(calls) == 1, f"attempted {len(calls)} connections without backing off"


def test_recovery_is_possible_once_the_window_passes(monkeypatch):
    """A transient blip must not disable memory features until the next deploy."""
    client = _install(monkeypatch, FakeClient(reachable=False))
    assert QdrantDB.get_client() is None

    client.reachable = True
    QdrantDB._last_attempt = time.monotonic() - settings.QDRANT_RETRY_SECONDS - 1
    assert QdrantDB.get_client() is not None


def test_health_reports_the_reason_not_just_a_boolean(monkeypatch):
    _install(monkeypatch, FakeClient(reachable=False))
    h = QdrantDB.health()
    assert h["connected"] is False
    assert "Connection reset" in (h.get("error") or "")


def test_host_is_logged_without_credentials(monkeypatch):
    monkeypatch.setattr(settings, "QDRANT_URL", "https://abc.cloud.qdrant.io:6333")
    assert QdrantDB._host_only() == "abc.cloud.qdrant.io:6333"
