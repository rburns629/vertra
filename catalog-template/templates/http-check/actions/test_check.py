"""Tests for http-check's check action, with the network faked: CI must
never depend on someone else's server (CI runs every actions/test_*.py)."""

import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


def load_action():
    spec = importlib.util.spec_from_file_location("check", Path(__file__).parent / "check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.action = load_action()
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        self.action.INPUT_PATH = folder / "request.json"
        self.action.OUTPUT_PATH = folder / "result.json"
        self.action.TOKEN_PATH = folder / "token"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_with(self, inputs: dict, respond) -> dict:
        self.action.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        with patch.object(self.action.urllib.request, "urlopen", side_effect=respond) as opened:
            self.action.main()
            self.opened = opened
        return json.loads(self.action.OUTPUT_PATH.read_text())

    def test_healthy(self) -> None:
        result = self.run_with({"url": "https://example.com"}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["outputs"], {"status": 200, "healthy": True})

    def test_refuses_plain_http(self) -> None:
        result = self.run_with({"url": "http://example.com"}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["error"]["code"], "INVALID_INPUT")

    def test_server_error_is_retryable(self) -> None:
        def boom(*_a, **_k):
            raise urllib.error.HTTPError("https://example.com", 503, "down", {}, io.BytesIO())
        result = self.run_with({"url": "https://example.com"}, boom)
        self.assertTrue(result["error"]["retryable"])

    def test_client_error_is_unhealthy_not_failed(self) -> None:
        def missing(*_a, **_k):
            raise urllib.error.HTTPError("https://example.com", 404, "nope", {}, io.BytesIO())
        result = self.run_with({"url": "https://example.com"}, missing)
        self.assertEqual(result["outputs"], {"status": 404, "healthy": False})

    def test_sends_the_token_and_never_returns_it(self) -> None:
        self.action.TOKEN_PATH.write_text("tok-123")
        result = self.run_with({"url": "https://example.com", "useToken": True}, lambda *a, **k: FakeResponse(200))
        sent = self.opened.call_args.args[0]
        self.assertEqual(sent.get_header("Authorization"), "Bearer tok-123")
        self.assertNotIn("tok-123", json.dumps(result))

    def test_names_the_missing_token(self) -> None:
        result = self.run_with({"url": "https://example.com", "useToken": True}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["error"]["code"], "MISSING_SECRET")


if __name__ == "__main__":
    unittest.main()
