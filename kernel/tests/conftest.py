# SPDX-License-Identifier: MIT
"""Shared fixtures for integration and end-to-end tests — real Postgres and a real
Kubernetes cluster (kind), not mocks.

Lives at the `tests/` root (not `tests/integration/`) so both
`tests/integration/` and `tests/end_to_end/` can use the same database and
image fixtures without duplicating them. Images are still built via the
Docker daemon (`docker_client` below) even though every test now dispatches
through KubernetesExecutor -- `docker build` remains the tool that produces
the image bytes; `kind load docker-image` is what gets them onto the test
cluster's nodes (see `_load_image_into_kind`).
"""

import os
import subprocess
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

import docker
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from kubernetes import client as k8s_client
from kubernetes import config as k8s_config
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.api.auth import require_caller
from app.api.dependencies import get_db_session
from app.main import app

# Same variable as console/vitest.config.ts; `make test` sets it.
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://localhost/execution_kernel_test"
)

DOCKER_TEST_IMAGE = "execution-kernel-test-fixture:local"
DOCKER_TEST_IMAGE_DIR = Path(__file__).parent / "fixtures" / "docker_test_image"

PROJECT_PRODUCT_IMAGE = "demo-project-product:local"
# The demo products live at the repo root (examples/), not inside kernel/.
EXAMPLES_DIR = Path(__file__).resolve().parents[2] / "examples"
PROJECT_PRODUCT_DIR = EXAMPLES_DIR / "project-product"

APPLICATION_PRODUCT_IMAGE = "demo-application-product:local"
APPLICATION_PRODUCT_DIR = EXAMPLES_DIR / "application-product"

K8S_NAMESPACE = "execution-kernel"

# Set in CI's Kubernetes job: there, a missing cluster or Docker daemon is a
# failure, not a reason to skip (locally they skip, so the rest still runs).
REQUIRE_KUBERNETES = os.environ.get("KERNEL_TESTS_REQUIRE_KUBERNETES") == "1"


def _unavailable(reason: str) -> NoReturn:
    if REQUIRE_KUBERNETES:
        pytest.fail(reason)
    pytest.skip(reason)


def _current_kind_cluster_name() -> str | None:
    """The kind cluster backing kubectl's current context, or None if the
    current context isn't a kind cluster at all -- kind always names its
    kubeconfig context "kind-<cluster-name>", so this is derived rather than
    hardcoded to whatever cluster a given machine happens to be running
    (the test suite and any demo environment can share one cluster this
    way, rather than each needing its own)."""
    try:
        result = subprocess.run(
            ["kubectl", "config", "current-context"], check=True, capture_output=True, text=True
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    context = result.stdout.strip()
    return context.removeprefix("kind-") if context.startswith("kind-") else None


@pytest_asyncio.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    # Function-scoped, not session-scoped: pytest-asyncio gives each test its
    # own event loop, and an asyncpg connection pool created on one loop
    # breaks ("another operation is in progress") if reused on another.
    test_engine = create_async_engine(TEST_DATABASE_URL)
    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """A session bound to a transaction that is rolled back after the test.

    Every test runs against a real schema (migrated via Alembic, not
    `create_all`) but leaves no trace, so tests can run in any order without
    truncating tables between them.
    """
    async with engine.connect() as connection:
        await connection.begin()
        session_factory = async_sessionmaker(
            bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        async with session_factory() as session:
            yield session
        await connection.rollback()


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """The real ASGI app over HTTP, with its DB dependency overridden to `db_session`
    so API tests get the same rolled-back-transaction isolation as everything else.
    Caller authentication is skipped; tests/unit/test_api_auth.py covers it."""

    async def override_get_db_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def allow_any_caller() -> None:
        return None

    app.dependency_overrides[get_db_session] = override_get_db_session
    app.dependency_overrides[require_caller] = allow_any_caller
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture(scope="session")
def docker_client() -> Iterator[docker.DockerClient]:
    """The real Docker daemon — skips every test that depends on it if unreachable."""
    try:
        client = docker.from_env()
        client.ping()
    except Exception as error:  # docker-py raises varied errors when the daemon is unreachable
        _unavailable(f"Docker daemon is not reachable: {error}")
    yield client
    client.close()


def _build_image(client: docker.DockerClient, path: Path, tag: str) -> str:
    """Built once per test session (not per test) — an image build, even of a
    trivial image, is much slower than the tests that use it."""
    client.images.build(path=str(path), tag=tag)
    return tag


@pytest.fixture(scope="session")
def docker_test_image(docker_client: docker.DockerClient) -> str:
    """The minimal fixture image used to exercise KubernetesExecutor's own mechanics
    (see k8s_test_image below, which loads this into the test cluster)."""
    return _build_image(docker_client, DOCKER_TEST_IMAGE_DIR, DOCKER_TEST_IMAGE)


@pytest.fixture(scope="session")
def project_product_image(docker_client: docker.DockerClient) -> str:
    """The fake project-product container from examples/project-product."""
    return _build_image(docker_client, PROJECT_PRODUCT_DIR, PROJECT_PRODUCT_IMAGE)


@pytest.fixture(scope="session")
def application_product_image(docker_client: docker.DockerClient) -> str:
    """The fake application-product container from examples/application-product."""
    return _build_image(docker_client, APPLICATION_PRODUCT_DIR, APPLICATION_PRODUCT_IMAGE)


@dataclass(frozen=True, slots=True)
class K8sApis:
    batch: k8s_client.BatchV1Api
    core: k8s_client.CoreV1Api
    namespace: str


@pytest.fixture(scope="session")
def k8s_apis() -> K8sApis:
    """The real cluster from the local kubeconfig — skips every test that depends
    on it if unreachable, same policy as `docker_client`."""
    try:
        k8s_config.load_kube_config()
        core = k8s_client.CoreV1Api()
        core.read_namespace(K8S_NAMESPACE)  # cheap connectivity + namespace-exists check
    except Exception as error:  # kubernetes-client raises varied errors when unreachable
        _unavailable(f"Kubernetes cluster is not reachable: {error}")
    return K8sApis(batch=k8s_client.BatchV1Api(), core=core, namespace=K8S_NAMESPACE)


def _load_image_into_kind(tag: str) -> None:
    """Images built locally aren't visible to a kind cluster's nodes on their own —
    kind runs its own containerd image store, separate from the host Docker daemon."""
    cluster_name = _current_kind_cluster_name()
    if cluster_name is None:
        _unavailable("Current kubectl context isn't a kind cluster — cannot load images into it.")
    try:
        subprocess.run(
            ["kind", "load", "docker-image", tag, "--name", cluster_name],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        _unavailable("'kind' CLI not found — cannot load images into the test cluster.")
    except subprocess.CalledProcessError as error:
        _unavailable(f"'kind load docker-image {tag}' failed: {error.stderr}")


@pytest.fixture(scope="session")
def k8s_test_image(docker_test_image: str, k8s_apis: K8sApis) -> str:
    """The minimal fixture image, loaded into the kind cluster used for testing."""
    _load_image_into_kind(docker_test_image)
    return docker_test_image


@pytest.fixture(scope="session")
def k8s_project_product_image(project_product_image: str, k8s_apis: K8sApis) -> str:
    _load_image_into_kind(project_product_image)
    return project_product_image


@pytest.fixture(scope="session")
def k8s_application_product_image(application_product_image: str, k8s_apis: K8sApis) -> str:
    _load_image_into_kind(application_product_image)
    return application_product_image
