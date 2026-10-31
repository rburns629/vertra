#!/usr/bin/env python3
"""aws/caller-identity's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. Which role a
run acts as is its own input, so all it can honestly find out is whether
the step gets its token for sts.amazonaws.com, and who that token says it
is (its iss and sub, read, not verified: AWS verifies it). Whether AWS
trusts that issuer, and a role lets that sub in, only whoami finds out.
"""

import base64
import json
import sys
from pathlib import Path
from typing import Any

OUTPUT_PATH = Path("/platform/output/result.json")
TOKEN_PATH = Path("/platform/tokens/sts.amazonaws.com")
SERVICE_ACCOUNT = "aws-caller-identity"


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _claims(token: str) -> dict[str, Any]:
    """A JWT's payload, unverified: only to say who it names."""
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def main() -> int:
    if not TOKEN_PATH.exists():
        _write_result({"status": "succeeded", "outputs": {
            "ready": False,
            "principal": f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, with no token for AWS",
            "missing": ["a token for sts.amazonaws.com: this install's release must carry the product's tokenAudiences"],
            "detail": f"No token at {TOKEN_PATH}.",
        }})
        return 0
    try:
        claims = _claims(TOKEN_PATH.read_text().strip())
    except (IndexError, ValueError):
        claims = {}
    issuer, subject = claims.get("iss", "?"), claims.get("sub", "?")
    _write_result({"status": "succeeded", "outputs": {
        "ready": True,
        "principal": subject,
        "missing": [],
        "detail": (
            f"It gets a token for sts.amazonaws.com from {issuer}. A run's role must trust that issuer "
            f"(an IAM OIDC identity provider) and let {subject} in."
        ),
    }})
    return 0


if __name__ == "__main__":
    sys.exit(main())
