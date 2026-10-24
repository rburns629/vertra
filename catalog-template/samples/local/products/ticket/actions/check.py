#!/usr/bin/env python3
"""ticket's "check" action: whether it's ready on this install (product.yaml's check).

Run by the console with no inputs, as this product's identity with its
secrets. A real product asks its cloud who it is and whether it may do
what its actions do; a pretend ticket needs nothing, so it's always ready.
"""

import json
import sys
from pathlib import Path

OUTPUT_PATH = Path("/platform/output/result.json")


def main() -> int:
    OUTPUT_PATH.write_text(json.dumps({
        "status": "succeeded",
        "outputs": {"ready": True, "principal": "this namespace's default ServiceAccount", "missing": []},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
