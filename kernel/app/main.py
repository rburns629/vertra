# SPDX-License-Identifier: MIT
"""FastAPI application entry point.

Run locally with:

    uvicorn app.main:app --reload

The API process never runs the scheduler loop itself — it only reads and
writes durable state. A separate scheduler process (not started here)
polls the same database.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.auth import authenticator_for
from app.api.routes import executions, health, metrics
from app.config import get_settings
from app.executors.kubernetes import load_kube_config
from app.observability.http_middleware import observability_middleware
from app.observability.logging import configure_logging
from app.persistence.database import create_engine, create_session_factory


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    engine = create_engine(
        settings.database_url, command_timeout_seconds=settings.database_command_timeout_seconds
    )
    app.state.session_factory = create_session_factory(engine)
    # Callers are checked with TokenReviews, so the API needs the cluster's config.
    app.state.authenticator = authenticator_for(settings)
    if app.state.authenticator is not None:
        load_kube_config()
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    configure_logging(service="kernel-api")
    app = FastAPI(title="execution-kernel", lifespan=lifespan)
    app.middleware("http")(observability_middleware)
    app.include_router(health.router)
    app.include_router(executions.router)
    app.include_router(metrics.router)
    return app


app = create_app()
