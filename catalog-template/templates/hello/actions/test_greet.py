"""Tests for hello's greet action. CI runs every actions/test_*.py inside the
product's own image, so a test needs nothing but the image itself:

    docker build -t hello:local teams/try-anna/products/hello
    docker run --rm --entrypoint python3 \
      -v "$(pwd)/teams/try-anna/products/hello/actions:/app/actions" \
      hello:local /app/actions/test_greet.py
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_action():
    spec = importlib.util.spec_from_file_location("greet", Path(__file__).parent / "greet.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GreetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.action = load_action()
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        # Point the action at a temporary folder instead of /platform.
        self.action.INPUT_PATH = folder / "request.json"
        self.action.OUTPUT_PATH = folder / "result.json"
        self.action.SECRET_PATH = folder / "secret"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_with(self, inputs: dict) -> dict:
        self.action.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        self.action.main()
        return json.loads(self.action.OUTPUT_PATH.read_text())

    def test_greets_by_name(self) -> None:
        result = self.run_with({"name": "Anna"})
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["outputs"]["message"], "Hello, Anna!")

    def test_needs_a_name(self) -> None:
        result = self.run_with({})
        self.assertEqual(result["error"]["code"], "MISSING_INPUT")

    def test_names_the_missing_secret(self) -> None:
        result = self.run_with({"name": "Anna", "useSecret": True})
        self.assertEqual(result["error"]["code"], "MISSING_SECRET")

    def test_finds_the_secret_and_never_returns_it(self) -> None:
        self.action.SECRET_PATH.write_text("s3cret-value")
        result = self.run_with({"name": "Anna", "useSecret": True})
        self.assertTrue(result["outputs"]["secretFound"])
        self.assertNotIn("s3cret-value", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
