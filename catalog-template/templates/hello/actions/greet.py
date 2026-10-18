#!/usr/bin/env python3
"""hello's "greet" action: the whole product contract in one small file.

1. Read the task's inputs from /platform/input/request.json.
2. Do the work.
3. Write the result to /platform/output/result.json:
   {"status": "succeeded", "outputs": {...}}, or
   {"status": "failed", "error": {"code", "message", "retryable"}}.
Anything printed shows up as the task's logs in the console, so never print
a secret.
"""

import json
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
# A secret added in the console for this product is a folder of files:
# /platform/secrets/<secret name>/<key>.
SECRET_PATH = Path("/platform/secrets/hello-secret/value")


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def fail(code: str, message: str, *, retryable: bool = False) -> int:
    write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}})
    return 1


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})

    name = inputs.get("name")
    if not isinstance(name, str) or not name.strip():
        return fail("MISSING_INPUT", "inputs.name is required: who should I greet?")

    secret_found = False
    if inputs.get("useSecret"):
        # Fail loudly, naming the path, rather than carrying on without it.
        if not SECRET_PATH.is_file():
            return fail(
                "MISSING_SECRET",
                f"{SECRET_PATH} isn't there. Add the secret hello-secret for this product in the "
                "console, and list it in the task's secretRefs.",
            )
        secret = SECRET_PATH.read_text().strip()
        secret_found = bool(secret)
        # Use it here (call an API with it, sign something); never print or return it.

    print(f"greeting {name}")
    write_result({"status": "succeeded", "outputs": {"message": f"Hello, {name}!", "secretFound": secret_found}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
