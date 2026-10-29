#!/usr/bin/env python3
"""ticket's "watch" action: watch a ticket, and report the watch as a resource.

Its ticket input is typed local.ticket (types.yaml), so an order wires it
from open's output or from a ticket the team already has, and the console
records that the watch depends on that ticket.
"""

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
MAX_LENGTH = 100


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False))


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    ticket = inputs.get("ticket")
    watcher = inputs.get("watcher")
    if not isinstance(ticket, str) or not re.fullmatch(r"T-[0-9a-f]{8}", ticket):
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": "inputs.ticket is required: a ticket's id, such as T-1a2b3c4d.", "retryable": False}})
        return 1
    if not isinstance(watcher, str) or not watcher.strip() or len(watcher) > MAX_LENGTH:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": f"inputs.watcher is required, up to {MAX_LENGTH} characters.", "retryable": False}})
        return 1

    # From the ticket and watcher, so running it again makes the same watch.
    watch = "W-" + hashlib.sha256(f"{ticket}/{watcher.strip()}".encode()).hexdigest()[:8]
    print(json.dumps({"level": "info", "msg": f"{watcher.strip()} watches {ticket} ({watch})"}))
    write_result({
        "status": "succeeded",
        "outputs": {
            "watch": watch,
            "resources": [{"type": "local/ticket-watch", "id": watch, "name": f"{watcher.strip()} on {ticket}"}],
        },
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
