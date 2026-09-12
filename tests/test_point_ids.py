"""
Regression tests for memory_service.point_id_for().

Point ids were `abs(hash(mongo_id)) % (2**63)`. Python randomises str hashing
per process (PEP 456), so the id written when a prompt was saved could not be
recomputed later — every delete silently targeted a point that did not exist,
and the vector kept being retrieved into that user's future enhancements.
"""

import subprocess
import sys

from backend.services.memory_service import point_id_for

MONGO_ID = "68b9f2c1e4a37d0091ab2f5e"


def test_stable_within_a_process():
    assert point_id_for(MONGO_ID) == point_id_for(MONGO_ID)


def test_distinct_ids_for_distinct_documents():
    assert point_id_for(MONGO_ID) != point_id_for("68b9f2c1e4a37d0091ab2f5f")


def _id_from_fresh_interpreter(seed: str) -> str:
    """Compute the point id in a subprocess with an explicit hash seed."""
    code = (
        "import sys; sys.path.insert(0, '.');"
        "import tests.conftest;"
        "from backend.services.memory_service import point_id_for;"
        f"print(point_id_for({MONGO_ID!r}))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, check=True,
        env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"},
    )
    return out.stdout.strip()


def test_stable_across_processes_with_different_hash_seeds():
    """
    The actual bug. Under randomised seeds the old scheme produced a different
    id every run; the whole point of the fix is that these two agree.
    """
    assert _id_from_fresh_interpreter("1") == _id_from_fresh_interpreter("2")


def test_old_scheme_really_was_unstable():
    """
    Guards the premise. If CPython ever stopped randomising str hashing this
    test would fail and the regression tests above would be checking nothing.
    """
    code = "print(abs(hash('68b9f2c1e4a37d0091ab2f5e')) % (2**63))"
    runs = {
        subprocess.run([sys.executable, "-c", code], capture_output=True,
                       text=True, check=True,
                       env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"}).stdout.strip()
        for seed in ("1", "2", "3")
    }
    assert len(runs) > 1, "str hash no longer varies by seed; revisit these tests"
