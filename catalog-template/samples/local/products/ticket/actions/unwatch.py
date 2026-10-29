#!/usr/bin/env python3
"""ticket's "unwatch" action: what deletes a watch watch reported (its cleanup).

Given {"resource": {"type", "id", "name"}}, as the console recorded it. A
watch already removed is removed all the same: a cleanup must succeed when
what it removes is already gone.
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
    watch = resource.get("id") if isinstance(resource, dict) else None
    if not isinstance(watch, str) or not watch:
        write_result({"status": "failed", "error": {"code": "MISSING_INPUT", "message": "inputs.resource.id is required: the watch to remove.", "retryable": False}})
        return 1

    print(json.dumps({"level": "info", "msg": f"removed {watch}"}))
    write_result({"status": "succeeded", "outputs": {"unwatched": watch}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
