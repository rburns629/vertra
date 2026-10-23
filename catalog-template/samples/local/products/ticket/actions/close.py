#!/usr/bin/env python3
"""ticket's "close" action: what deletes a ticket open reported (its cleanup).

Given {"resource": {"type", "id", "name"}}, as the console recorded it. A
ticket already closed, or never opened, is closed all the same: a cleanup
must succeed when what it removes is already gone.
"""

import json
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False))


def main() -> int:
    resource = json.loads(INPUT_PATH.read_text()).get("inputs", {}).get("resource")
    ticket = resource.get("id") if isinstance(resource, dict) else None
    if not isinstance(ticket, str) or not ticket:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": "inputs.resource.id is required: the ticket to close.", "retryable": False}})
        return 1

    print(json.dumps({"level": "info", "msg": f"closed {ticket}"}))
    write_result({"status": "succeeded", "outputs": {"closed": ticket}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
