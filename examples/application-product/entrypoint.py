# SPDX-License-Identifier: MIT
"""Fake application-product container: deploys an "application" into a project.

Implements the same product container contract as project-product — see
that container for the contract details. Intentionally has no code in
common with it: separate products in a real deployment are separate
vendors' images, built independently, and shouldn't share a library.
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
                    "message": f"application-product does not support action '{action}'",
                    "retryable": False,
                },
            }
        )
        return 1

    project_id = inputs.get("projectId")
    if not project_id:
        _write_result(
            {
                "status": "failed",
                "error": {
                    "code": "MISSING_INPUT",
                    "message": "inputs.projectId is required to deploy an application",
                    "retryable": False,
                },
            }
        )
        return 1

    print(f"deploying application into project '{project_id}'")
    _write_result({"status": "succeeded", "outputs": {"applicationUrl": "https://demo.example"}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
