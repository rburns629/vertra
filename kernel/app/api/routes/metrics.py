# SPDX-License-Identifier: MIT
"""Prometheus scrape endpoint.

Unauthenticated, same as /health — metrics carry no sensitive data, and
every Prometheus-compatible scraper (self-hosted Prometheus, GKE Managed
Prometheus, etc.) expects a plain GET with no credentials.
"""

from fastapi import APIRouter, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

router = APIRouter(tags=["metrics"])


@router.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
