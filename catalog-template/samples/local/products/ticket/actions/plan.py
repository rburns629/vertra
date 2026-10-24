#!/usr/bin/env python3
"""ticket's "plan" action: what open would do, without doing it (Preview).

Outputs {"changes": [{action, type, id, name}], "summary"}: the console shows
these before anything runs, and to whoever approves a step.
"""

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
MAX_LENGTH = 200


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False))


def main() -> int:
    title = json.loads(INPUT_PATH.read_text()).get("inputs", {}).get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > MAX_LENGTH:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": f"inputs.title is required, up to {MAX_LENGTH} characters.", "retryable": False}})
        return 1

    # The same id open would give it.
    ticket = "T-" + hashlib.sha256(title.strip().encode()).hexdigest()[:8]
    write_result({
        "status": "succeeded",
        "outputs": {
            "summary": f"Opens ticket {ticket}.",
            "changes": [{"action": "create", "type": "local/ticket", "id": ticket, "name": title.strip()}],
        },
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
