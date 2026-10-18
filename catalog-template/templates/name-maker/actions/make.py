#!/usr/bin/env python3
"""name-maker's "make" action: outputs a value for a later task to use.

A later task in the same DAG takes it with
{"$fromTask": "<this task's id>", "$output": "name"}: the platform fills it
in before that task starts, so neither product knows about the other.
"""

import json
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    first = str(inputs.get("first", "")).strip()
    last = str(inputs.get("last", "")).strip()
    if not first:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": "inputs.first is required.", "retryable": False}})
        return 1
    name = f"{first} {last}".strip()
    print(f"made name {name!r}")
    write_result({"status": "succeeded", "outputs": {"name": name}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
