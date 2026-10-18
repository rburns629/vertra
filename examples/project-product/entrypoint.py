# SPDX-License-Identifier: MIT
"""Fake project-product container: creates a "project" and returns its id.

Implements the execution-kernel product container contract:
- Reads /platform/input/request.json.
- Writes /platform/output/result.json on both success and failure.
- Exits 0 on success, non-zero on failure.

A real product would call out to whatever system actually creates a
project; this one is deterministic so the demo DAG's chaining is
reproducible without any external dependency.
"""

import json
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})

    if action != "create":
        _write_result(
            {
                "status": "failed",
                "error": {
                    "code": "UNSUPPORTED_ACTION",
                    "message": f"project-product does not support action '{action}'",
                    "retryable": False,
                },
            }
        )
        return 1

    project_name = inputs.get("projectName")
    if not project_name:
        _write_result(
            {
                "status": "failed",
                "error": {
                    "code": "MISSING_INPUT",
                    "message": "inputs.projectName is required to create a project",
                    "retryable": False,
                },
            }
        )
        return 1

    project_id = f"{project_name}-123"
    print(f"created project '{project_name}' -> {project_id}")
    _write_result({"status": "succeeded", "outputs": {"projectId": project_id}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
