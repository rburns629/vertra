# SPDX-License-Identifier: MIT
"""Structured JSON logging.

One log line per record, as a JSON object on stdout — the same shape
whether the process is running under ``kubectl logs`` on a local `kind`
cluster or as a container on GKE (or any other Kubernetes). Cloud Logging on GKE parses
a JSON stdout payload automatically and maps the ``severity`` field to its
own log levels; any other stack that ingests container stdout as JSON lines
(Loki, ELK, ...) gets the same structured fields for free, without coupling
this code to a specific provider's logging SDK.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

# Attributes every stdlib LogRecord carries. Anything *not* in this set was
# passed via `extra={...}` at the call site and belongs in the JSON payload.
_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
    "message",
    "asctime",
}


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "severity": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS:
                payload[key] = value
        return json.dumps(payload, default=str)


class _ServiceFilter(logging.Filter):
    """Stamps every record with a constant ``service`` field, so call sites
    never have to pass it themselves."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = self._service
        return True


def configure_logging(service: str, *, level: int = logging.INFO) -> None:
    """Replace the root logger's handlers with a single JSON stdout handler.

    Called once at process startup by each entry point (``app.main``,
    ``app.scheduler.__main__``) so every log line — including ones emitted
    by uvicorn or third-party libraries — comes out structured.
    """
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    handler.addFilter(_ServiceFilter(service))

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
