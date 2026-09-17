from backend.services import llm_service


class CountingEncoder:
    def __init__(self):
        self.calls = []

    def encode(self, text, convert_to_numpy=True):
        self.calls.append(text)
        return type("Vector", (), {"tolist": lambda self: [1.0, 2.0, 3.0]})()


def _install_encoder(monkeypatch):
    encoder = CountingEncoder()
    monkeypatch.setattr(llm_service, "_embedding_model", encoder)
    monkeypatch.setattr(llm_service, "_embedding_unavailable", False)
    llm_service.clear_embedding_cache()
    return encoder


def test_identical_context_queries_are_encoded_once(monkeypatch):
    encoder = _install_encoder(monkeypatch)

    assert llm_service.get_embedding("same prompt") == [1.0, 2.0, 3.0]
    assert llm_service.get_embedding("same prompt") == [1.0, 2.0, 3.0]

    assert encoder.calls == ["same prompt"]
    assert llm_service.embedding_status()["cache"]["hits"] == 1


def test_cached_vectors_cannot_be_mutated_by_a_caller(monkeypatch):
    encoder = _install_encoder(monkeypatch)
    first = llm_service.get_embedding("safe prompt")
    first[0] = 999

    assert llm_service.get_embedding("safe prompt") == [1.0, 2.0, 3.0]
    assert encoder.calls == ["safe prompt"]


def test_different_queries_get_different_cache_entries(monkeypatch):
    encoder = _install_encoder(monkeypatch)
    llm_service.get_embedding("one")
    llm_service.get_embedding("two")

    assert encoder.calls == ["one", "two"]
    assert llm_service.embedding_status()["cache"]["size"] == 2


def test_embedding_status_is_not_stale(monkeypatch):
    _install_encoder(monkeypatch)
    assert llm_service.embedding_status()["loaded"] is True

    monkeypatch.setattr(llm_service, "_embedding_model", None)
    assert llm_service.embedding_status()["loaded"] is False
