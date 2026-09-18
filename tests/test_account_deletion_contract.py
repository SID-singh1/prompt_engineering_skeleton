"""Dependency-free deletion contract checks with synthetic user data.

Run with: python3 tests/test_account_deletion_contract.py
The FastAPI HTTP tests in test_api_integration.py provide the full-stack check
when the project's test dependencies are available.
"""

import ast
import unittest
from pathlib import Path
from types import SimpleNamespace


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeCollection:
    def __init__(self, rows, fail=False):
        self.rows = rows
        self.fail = fail

    def delete_many(self, query):
        if self.fail:
            raise RuntimeError("synthetic store outage")
        before = len(self.rows)
        self.rows[:] = [row for row in self.rows if row.get("user_id") != query["user_id"]]
        return SimpleNamespace(deleted_count=before - len(self.rows))


class AccountDeletionContract(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "backend/routers/users.py"
        tree = ast.parse(source.read_text())
        method = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "delete_me")
        method.decorator_list = []
        self.method = method

    def make_handler(self, *, mongo=False, vector_result=None, failing_store=None):
        self.users = {
            "sample": {"user_id": "sample", "email": "hello-deletion@example.test"},
            "other": {"user_id": "other", "email": "other@example.test"},
        }
        self.logs = [{"user_id": "sample"}, {"user_id": "other"}]
        self.saved = {"one": {"user_id": "sample"}, "two": {"user_id": "other"}}
        self.analytics = [{"user_id": "sample"}, {"user_id": "other"}]
        collections = {
            "users_col": FakeCollection(list(self.users.values())),
            "prompts_col": FakeCollection(list(self.logs)),
            "saved_prompts_col": FakeCollection(list(self.saved.values())),
            "feedback_col": FakeCollection([{"user_id": "sample"}]),
            "analytics_col": FakeCollection(list(self.analytics)),
            "prompt_feedback": FakeCollection([{"user_id": "sample"}]),
        }
        if failing_store:
            collections[failing_store].fail = True
        database = {"prompt_feedback": collections["prompt_feedback"]} if mongo else None
        fake_mongo = SimpleNamespace(db=database, **{k: v for k, v in collections.items() if k != "prompt_feedback"})
        fake_memory = SimpleNamespace(purge_user_vectors=lambda _: vector_result or {
            "prompt_memory": "deleted", "saved_prompt_vectors": "deleted"})
        namespace = {
            "Depends": lambda _: None,
            "verify_jwt": None,
            "HTTPException": FakeHTTPException,
            "MongoDB": fake_mongo,
            "MemoryService": fake_memory,
            "settings": SimpleNamespace(MONGO_URI=None),
            "in_memory_users": self.users,
            "in_memory_prompt_logs": self.logs,
            "in_memory_saved_prompts": self.saved,
            "in_memory_analytics_events": self.analytics,
        }
        exec(compile(ast.Module(body=[self.method], type_ignores=[]), str(Path(__file__)), "exec"), namespace)
        return namespace["delete_me"], collections

    def test_synthetic_email_and_other_user_are_scoped(self):
        delete, _ = self.make_handler()
        result = delete("sample")
        self.assertEqual(result["message"], "Account and associated data deleted.")
        self.assertNotIn("sample", self.users)
        self.assertIn("other", self.users)
        self.assertEqual([x["user_id"] for x in self.logs], ["other"])
        self.assertEqual([x["user_id"] for x in self.analytics], ["other"])
        self.assertEqual(list(self.saved), ["two"])

    def test_vector_outage_keeps_account_for_retry(self):
        delete, _ = self.make_handler(vector_result={"qdrant": "unavailable"})
        with self.assertRaises(FakeHTTPException) as raised:
            delete("sample")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("sample", self.users)

    def test_configured_mongo_outage_does_not_claim_success(self):
        delete, _ = self.make_handler()
        delete.__globals__["settings"].MONGO_URI = "mongodb://configured-but-unavailable"
        with self.assertRaises(FakeHTTPException) as raised:
            delete("sample")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("sample", self.users)
        self.assertEqual([x["user_id"] for x in self.logs], ["sample", "other"])

    def test_mongo_failure_keeps_profile_and_reports_partial_deletion(self):
        delete, collections = self.make_handler(mongo=True, failing_store="feedback_col")
        with self.assertRaises(FakeHTTPException) as raised:
            delete("sample")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(len(collections["users_col"].rows), 2)
        self.assertIn("feedback", raised.exception.detail["failed_stores"])

    def test_mongo_success_removes_all_user_scoped_collections(self):
        delete, collections = self.make_handler(mongo=True)
        result = delete("sample")
        self.assertEqual(result["message"], "Account and associated data deleted.")
        for name in ("users_col", "prompts_col", "saved_prompts_col", "feedback_col", "analytics_col", "prompt_feedback"):
            self.assertFalse(any(row["user_id"] == "sample" for row in collections[name].rows), name)
        self.assertEqual([row["user_id"] for row in collections["users_col"].rows], ["other"])


if __name__ == "__main__":
    unittest.main()
