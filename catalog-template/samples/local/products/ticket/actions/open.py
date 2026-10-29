#!/usr/bin/env python3
"""ticket's "open" action: open a pretend ticket, and report it as a resource.

Reads /platform/input/request.json, writes /platform/output/result.json:
{"status": "succeeded", "outputs": {...}} or
{"status": "failed", "error": {"code", "message", "retryable"}}.
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
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    title = inputs.get("title")
    problem = None
    if not isinstance(title, str):
        problem = "inputs.title is required: what the ticket is about."
    elif not title.strip():
        problem = "inputs.title is blank: say what the ticket is about."
    elif len(title) > MAX_LENGTH:
        problem = f"inputs.title is too long: at most {MAX_LENGTH} characters."
    if problem:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": problem, "retryable": False}})
        return 1

    # From the title, so running it again opens the same ticket.
    ticket = "T-" + hashlib.sha256(title.strip().encode()).hexdigest()[:8]
    print(json.dumps({"level": "info", "msg": f"opened {ticket}"}))
    write_result({
        "status": "succeeded",
        "outputs": {
            "ticket": ticket,
            # What the console keeps, and what close is given to delete it.
            "resources": [{"type": "local/ticket", "id": ticket, "name": title.strip()}],
        },
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
