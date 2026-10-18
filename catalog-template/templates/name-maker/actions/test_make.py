"""Tests for name-maker's make action (CI runs every actions/test_*.py)."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_action():
    spec = importlib.util.spec_from_file_location("make", Path(__file__).parent / "make.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.action = load_action()
        self.tmp = tempfile.TemporaryDirectory()
        self.action.INPUT_PATH = Path(self.tmp.name) / "request.json"
        self.action.OUTPUT_PATH = Path(self.tmp.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_with(self, inputs: dict) -> dict:
        self.action.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        self.action.main()
        return json.loads(self.action.OUTPUT_PATH.read_text())

    def test_first_and_last(self) -> None:
        self.assertEqual(self.run_with({"first": "Anna", "last": "Berg"})["outputs"]["name"], "Anna Berg")

    def test_first_only(self) -> None:
        self.assertEqual(self.run_with({"first": "Anna"})["outputs"]["name"], "Anna")

    def test_needs_a_first_name(self) -> None:
        self.assertEqual(self.run_with({})["error"]["code"], "MISSING_INPUT")


if __name__ == "__main__":
    unittest.main()
