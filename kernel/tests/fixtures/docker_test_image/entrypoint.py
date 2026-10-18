# SPDX-License-Identifier: MIT
"""Test-only fixture image entrypoint — exercises KubernetesExecutor's own mechanics, not the
real product contract.

Behavior is driven by the action argument and by `inputs` in request.json:

- action "crash": exits nonzero without writing result.json, to exercise the
  PRODUCT_RESULT_MISSING path.
- action "sleep": sleeps for `inputs.seconds` (default 30) before succeeding,
  printing a line each second, to give tests something long-running enough
  to cancel(), with output that grows while it runs.
- inputs.shouldFail is true: writes a failed result.json and exits nonzero.
- otherwise: writes a succeeded result.json echoing the action and inputs.
"""

import json
import sys
import time
from pathlib import Path

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})

    if action == "crash":
        print("crashing deliberately without writing a result file", file=sys.stderr)
        sys.exit(1)

    if action == "sleep":
        for second in range(int(inputs.get("seconds", 30))):
            print(f"still working: {second}s", flush=True)
            time.sleep(1)
        OUTPUT_PATH.write_text(json.dumps({"status": "succeeded", "outputs": {}}))
        sys.exit(0)

    if inputs.get("shouldFail"):
        OUTPUT_PATH.write_text(
            json.dumps(
                {
                    "status": "failed",
                    "error": {
                        "code": "TEST_FAILURE",
                        "message": "deliberate test failure",
                        "retryable": False,
                    },
                }
            )
        )
        sys.exit(1)

    print(f"running action={action}")
    print(f"inputs: {json.dumps(inputs)}")
    OUTPUT_PATH.write_text(
        json.dumps(
            {
                "status": "succeeded",
                "outputs": {"echoedAction": action, "receivedInputs": inputs},
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
