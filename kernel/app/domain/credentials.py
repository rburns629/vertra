# SPDX-License-Identifier: MIT
"""Recognizing credentials in what a step sends back, so they aren't stored.

The kernel never sees a secret's value (steps mount them; nothing here reads
them), so it can't redact by value. What it can do is recognize the shapes
real credentials have: a PEM private key, a cloud access key, a GitHub or
Slack token. Logs are for people, so a match there is replaced with
``[redacted <kind>]``; outputs are data that flows to later steps and to
anyone who can read the execution, so a match there fails the task instead
of quietly changing what it produced (KubernetesExecutor).

Only shapes specific enough not to match ordinary output are used; this is
a backstop for a product that echoes a credential by mistake, not a reason
to print one. Bearer tokens and JWTs are redacted from logs but don't fail
outputs: a product may return a short-lived token on purpose, and a JWT's
shape alone doesn't say it's a standing credential.
"""

import re
from typing import Any

_PEM_BEGIN = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
_PEM_END = re.compile(r"-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")

# (kind, pattern): each one specific to a provider's format.
_TOKENS: list[tuple[str, re.Pattern[str]]] = [
    ("private key", _PEM_BEGIN),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "GitHub token",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b"),
    ),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Stripe key", re.compile(r"\b[rs]k_live_[0-9A-Za-z]{20,}\b")),
    ("Azure storage key", re.compile(r"AccountKey=[A-Za-z0-9+/]{40,}={0,2}")),
]
# Redacted from logs only (see the module docstring).
_LOG_ONLY: list[tuple[str, re.Pattern[str]]] = [
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{20,}=*")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
]


def redact_text(text: str) -> str:
    """``text`` with every recognized credential replaced. A PEM key's
    BEGIN marker through its END marker (or the end of the text) goes."""
    text = re.sub(
        _PEM_BEGIN.pattern + r"[\s\S]*?(?:" + _PEM_END.pattern + r"|$)",
        "[redacted private key]",
        text,
    )
    for kind, pattern in _TOKENS[1:] + _LOG_ONLY:
        text = pattern.sub(f"[redacted {kind}]", text)
    return text


def redact_lines(lines: list[str]) -> list[str]:
    """Log lines with credentials redacted; a PEM key spans lines, so every
    line from its BEGIN to its END marker is replaced by one marker line."""
    redacted: list[str] = []
    in_key = False
    for line in lines:
        if in_key:
            if _PEM_END.search(line):
                in_key = False
            continue
        begin = _PEM_BEGIN.search(line)
        if begin and not _PEM_END.search(line, begin.end()):
            in_key = True
            redacted.append(redact_text(line[: begin.start()]) + "[redacted private key]")
            continue
        redacted.append(redact_text(line))
    return redacted


def find_credential(value: Any) -> str | None:
    """The kind of the first credential found anywhere in ``value`` (JSON:
    keys and values, at any depth), or None."""
    if isinstance(value, str):
        for kind, pattern in _TOKENS:
            if pattern.search(value):
                return kind
        return None
    if isinstance(value, dict):
        for key, item in value.items():
            found = find_credential(key) or find_credential(item)
            if found:
                return found
        return None
    if isinstance(value, list):
        for item in value:
            found = find_credential(item)
            if found:
                return found
    return None
