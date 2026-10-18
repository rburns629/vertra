# SPDX-License-Identifier: MIT
"""Per-request access logging and HTTP metrics, as one ASGI middleware so
both concerns share a single timer and a single request id instead of two
separate wrappers.
"""

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from app.observability.metrics import HTTP_REQUEST_DURATION_SECONDS, HTTP_REQUESTS_TOTAL

logger = logging.getLogger("app.access")


async def observability_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    start = time.perf_counter()

    response = await call_next(request)

    duration_seconds = time.perf_counter() - start
    # request.scope["route"] is set by the router during call_next(), so by
    # the time it returns this is the path *template* ("/v1/executions/
    # {execution_id}"), not the literal URL — keeps the metric's cardinality
    # bounded regardless of how many distinct execution ids get requested.
    # Falls back to the raw path only for unmatched routes (404s).
    route = request.scope.get("route")
    path_template = route.path if route is not None else request.url.path

    HTTP_REQUESTS_TOTAL.labels(
        method=request.method, path=path_template, status=response.status_code
    ).inc()
    HTTP_REQUEST_DURATION_SECONDS.labels(method=request.method, path=path_template).observe(
        duration_seconds
    )

    response.headers["X-Request-ID"] = request_id
    logger.info(
        "request handled",
        extra={
            "requestId": request_id,
            "httpMethod": request.method,
            "httpPath": path_template,
            "httpStatus": response.status_code,
            "durationMs": round(duration_seconds * 1000, 2),
        },
    )
    return response
