# SPDX-License-Identifier: MIT
"""Integration tests for app.executors.kubernetes.KubernetesExecutor — a real cluster (kind),
not mocks. Uses the same minimal fixture image the Docker executor tests use
(tests/fixtures/docker_test_image) — this is about KubernetesExecutor's own mechanics
(ConfigMap input, termination-message output, cleanup, cancellation), independent of
what any particular product image does.
"""

import asyncio
import subprocess
import time
import uuid
from collections.abc import Iterator

import pytest
from kubernetes import client as k8s_client
from kubernetes.client.exceptions import ApiException

from app.executors.base import ExecutorRunState, ResolvedTask
from app.executors.kubernetes import KubernetesExecutor
from tests.conftest import K8sApis
from tests.integration.executor_helpers import wait_for_terminal


def _task(
    action: str, inputs: dict[str, object] | None = None, *, image: str, **overrides: object
) -> ResolvedTask:
    defaults: dict[str, object] = {
        "execution_id": "exec-test",
        "task_key": f"task-{action}",
        "image": image,
        "action": action,
        "attempt": 1,
        "resolved_inputs": inputs or {},
        "timeout_seconds": 60,
        # Must be a namespace that actually exists in the test cluster, since
        # this is what KubernetesExecutor now dispatches into — see
        # tests.conftest.K8S_NAMESPACE. "default" is the ServiceAccount every
        # namespace has out of the box; no fixture-side RBAC setup needed for
        # tests that aren't specifically about RBAC scoping.
        "team": "execution-kernel",
        "service_account": "default",
    }
    defaults.update(overrides)
    return ResolvedTask(**defaults)  # type: ignore[arg-type]


def _executor(k8s_apis: K8sApis) -> KubernetesExecutor:
    return KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)


class TestKubernetesExecutorSuccessAndFailure:
    async def test_successful_task_returns_outputs(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("greet", {"name": "world"}, image=k8s_test_image)

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle, timeout=30.0)

        assert status.state is ExecutorRunState.SUCCEEDED
        assert status.outputs == {"echoedAction": "greet", "receivedInputs": {"name": "world"}}

    async def test_product_declared_failure_is_relayed_as_is(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("create", {"shouldFail": True}, image=k8s_test_image)

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle, timeout=30.0)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "TEST_FAILURE"
        assert status.error.retryable is False

    async def test_crash_without_result_file_gets_synthetic_error(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("crash", image=k8s_test_image)

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle, timeout=30.0)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "PRODUCT_RESULT_MISSING"
        assert status.error.retryable is True


class TestKubernetesExecutorLifecycle:
    async def test_get_status_reports_running_before_completion(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("sleep", {"seconds": 20}, image=k8s_test_image)

        handle = await executor.start(task)
        try:
            # Give the Pod a moment to actually schedule and start before
            # asserting it's RUNNING rather than not-yet-observed.
            await asyncio.sleep(3)
            status = await executor.get_status(handle)
            assert status.state is ExecutorRunState.RUNNING
        finally:
            await executor.cancel(handle)

    async def test_cancel_stops_a_running_job(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("sleep", {"seconds": 60}, image=k8s_test_image)

        handle = await executor.start(task)
        await executor.cancel(handle)

        # Deleting the Job means a subsequent status check finds nothing —
        # KubernetesExecutor treats that as terminal (cancelled) rather than
        # letting the 404 propagate.
        status = await wait_for_terminal(executor, handle, timeout=30.0)
        assert status.state is ExecutorRunState.FAILED

    async def test_cancel_is_idempotent(self, k8s_apis: K8sApis, k8s_test_image: str) -> None:
        executor = _executor(k8s_apis)
        task = _task("sleep", {"seconds": 30}, image=k8s_test_image)

        handle = await executor.start(task)
        await executor.cancel(handle)
        await executor.cancel(handle)  # must not raise


class TestKubernetesExecutorExtraEnvironment:
    async def test_extra_environment_applied_to_every_dispatched_pod(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = KubernetesExecutor(
            batch_api=k8s_apis.batch,
            core_api=k8s_apis.core,
            extra_environment={"GCP_TARGET_SERVICE_ACCOUNT": "sa@x.iam.gserviceaccount.com"},
        )
        task = _task("sleep", {"seconds": 30}, image=k8s_test_image)

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], k8s_apis.namespace)
            container = job.spec.template.spec.containers[0]
            env_by_name = {entry.name: entry.value for entry in (container.env or [])}
            assert env_by_name == {"GCP_TARGET_SERVICE_ACCOUNT": "sa@x.iam.gserviceaccount.com"}
        finally:
            await executor.cancel(handle)

    async def test_no_env_on_container_when_not_configured(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("sleep", {"seconds": 30}, image=k8s_test_image)

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], k8s_apis.namespace)
            container = job.spec.template.spec.containers[0]
            assert not container.env
        finally:
            await executor.cancel(handle)

    async def test_pod_is_labelled_with_its_execution_and_task(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        # Its own execution id: every other test shares one, so their Jobs
        # (and still-terminating Pods) have the same name as this one's.
        task = _task(
            "sleep", {"seconds": 30}, image=k8s_test_image, execution_id=str(uuid.uuid4())
        )

        handle = await executor.start(task)
        try:
            # The Job controller creates the Pod a moment after the Job.
            pods = []
            for _ in range(30):
                pods = k8s_apis.core.list_namespaced_pod(
                    k8s_apis.namespace, label_selector=f"job-name={handle['jobName']}"
                ).items
                if pods:
                    break
                await asyncio.sleep(0.5)
            assert len(pods) == 1
            assert pods[0].metadata.labels["acyclix.dev/execution-id"] == task.execution_id
            assert pods[0].metadata.labels["acyclix.dev/attempt"] == str(task.attempt)
            assert pods[0].metadata.annotations["acyclix.dev/task"] == task.task_key
        finally:
            await executor.cancel(handle)

    async def test_get_logs_returns_captured_stdout(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("greet", image=k8s_test_image)

        handle = await executor.start(task)
        await wait_for_terminal(executor, handle, timeout=30.0)
        logs = await executor.get_logs(handle)

        assert "running action=greet" in logs

    async def test_terminal_state_is_cached_and_resources_are_cleaned_up(
        self, k8s_apis: K8sApis, k8s_test_image: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task("greet", image=k8s_test_image)

        handle = await executor.start(task)
        job_name = handle["jobName"]
        first_status = await wait_for_terminal(executor, handle, timeout=30.0)

        # The Job and its ConfigMap should be gone now...
        with pytest.raises(ApiException) as job_error:
            k8s_apis.batch.read_namespaced_job_status(job_name, k8s_apis.namespace)
        assert job_error.value.status == 404

        with pytest.raises(ApiException) as config_map_error:
            k8s_apis.core.read_namespaced_config_map(job_name, k8s_apis.namespace)
        assert config_map_error.value.status == 404

        # ...but the handle is still fully usable, served from the in-memory cache.
        second_status = await executor.get_status(handle)
        assert second_status == first_status
        logs = await executor.get_logs(handle)
        assert "running action=greet" in logs


@pytest.fixture
def second_team_namespace(k8s_apis: K8sApis) -> Iterator[str]:
    """A second, distinct namespace, standing in for a different platform team's --
    proves dispatch namespace actually varies per task, not just that it's
    configurable. Torn down after each test so RBAC objects created within it
    (see the isolation test below) don't leak between tests."""
    name = "gcp-team-test"
    k8s_apis.core.create_namespace(k8s_client.V1Namespace(metadata={"name": name}))
    try:
        yield name
    finally:
        k8s_apis.core.delete_namespace(name)
        # Namespace deletion is async (finalizers) -- without waiting for it
        # to actually finish, the next test's create_namespace races the
        # still-terminating namespace and gets a 409.
        for _ in range(60):
            try:
                k8s_apis.core.read_namespace(name)
            except ApiException as error:
                if error.status == 404:
                    break
                raise
            time.sleep(1)


class TestKubernetesExecutorTeamDispatch:
    """Proves the actual point of the team/service_account fields (see
    app/contracts/task.py): a task's declared team determines where its Job
    is dispatched, and its declared ServiceAccount is the Pod's identity
    (what a cloud binding attaches to), not a shared default one.
    """

    async def test_task_is_dispatched_into_its_declared_team_namespace(
        self, k8s_apis: K8sApis, k8s_test_image: str, second_team_namespace: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task(
            "greet", image=k8s_test_image, team=second_team_namespace, service_account="default"
        )

        handle = await executor.start(task)
        try:
            assert handle["namespace"] == second_team_namespace
            # It must actually be there, not just recorded as there.
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
            assert job.metadata.namespace == second_team_namespace
        finally:
            await executor.cancel(handle)

    async def test_pod_runs_as_the_tasks_declared_service_account(
        self, k8s_apis: K8sApis, k8s_test_image: str, second_team_namespace: str
    ) -> None:
        sa_name = "gcp-demo-sa"
        k8s_apis.core.create_namespaced_service_account(
            second_team_namespace, k8s_client.V1ServiceAccount(metadata={"name": sa_name})
        )
        executor = _executor(k8s_apis)
        task = _task(
            "greet", image=k8s_test_image, team=second_team_namespace, service_account=sa_name
        )

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
            assert job.spec.template.spec.service_account_name == sa_name
        finally:
            await executor.cancel(handle)

    async def test_service_account_can_only_reach_secrets_it_was_granted_via_rbac(
        self, k8s_apis: K8sApis, k8s_test_image: str, second_team_namespace: str
    ) -> None:
        """The end-to-end claim this whole feature exists for: dispatching a task
        with a given team/service_account, then checking — via the real
        Kubernetes authorizer, not application logic — that only the
        ServiceAccount actually granted access (the same Role/RoleBinding
        shape console/'s k8s.ts provisions) can read the target Secret."""
        granted_sa = "gcp-granted-sa"
        ungranted_sa = "gcp-ungranted-sa"
        secret_name = "gcp-demo-secret"
        for name in (granted_sa, ungranted_sa):
            k8s_apis.core.create_namespaced_service_account(
                second_team_namespace, k8s_client.V1ServiceAccount(metadata={"name": name})
            )
        k8s_apis.core.create_namespaced_secret(
            second_team_namespace,
            k8s_client.V1Secret(
                metadata={"name": secret_name}, string_data={"value": "top-secret"}
            ),
        )
        role_name = f"read-secret-{secret_name}"
        rbac_api = k8s_client.RbacAuthorizationV1Api(k8s_apis.core.api_client)
        rbac_api.create_namespaced_role(
            second_team_namespace,
            k8s_client.V1Role(
                metadata={"name": role_name},
                rules=[
                    k8s_client.V1PolicyRule(
                        api_groups=[""],
                        resources=["secrets"],
                        resource_names=[secret_name],
                        verbs=["get"],
                    )
                ],
            ),
        )
        rbac_api.create_namespaced_role_binding(
            second_team_namespace,
            k8s_client.V1RoleBinding(
                metadata={"name": f"{role_name}-to-{granted_sa}"},
                role_ref=k8s_client.V1RoleRef(
                    api_group="rbac.authorization.k8s.io", kind="Role", name=role_name
                ),
                subjects=[
                    k8s_client.RbacV1Subject(
                        kind="ServiceAccount", name=granted_sa, namespace=second_team_namespace
                    )
                ],
            ),
        )

        executor = _executor(k8s_apis)
        granted_task = _task(
            "greet",
            image=k8s_test_image,
            team=second_team_namespace,
            service_account=granted_sa,
            task_key="task-greet-granted",
        )
        ungranted_task = _task(
            "greet",
            image=k8s_test_image,
            team=second_team_namespace,
            service_account=ungranted_sa,
            task_key="task-greet-ungranted",
        )
        granted_handle = await executor.start(granted_task)
        ungranted_handle = await executor.start(ungranted_task)
        try:
            assert _can_read_secret(second_team_namespace, granted_sa, secret_name) is True
            assert _can_read_secret(second_team_namespace, ungranted_sa, secret_name) is False
        finally:
            await executor.cancel(granted_handle)
            await executor.cancel(ungranted_handle)


def _can_read_secret(namespace: str, service_account: str, secret_name: str) -> bool:
    result = subprocess.run(
        [
            "kubectl",
            "auth",
            "can-i",
            "get",
            f"secret/{secret_name}",
            "-n",
            namespace,
            "--as",
            f"system:serviceaccount:{namespace}:{service_account}",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() == "yes"


class TestKubernetesExecutorImagePullPolicy:
    """catalog-ci pushes a registry-qualified ":latest" tag alongside each
    product's immutable SHA tag (see acyclix-catalog's ci.yml) --
    meant to be genuinely mutable, so it needs Always, not the IfNotPresent
    every other image reference correctly gets (see the comment beside
    image_pull_policy in app/executors/kubernetes.py for the full
    reasoning, including why a bare/unqualified ":latest" -- kind's own
    local-build convention -- must NOT get Always)."""

    async def test_registry_qualified_latest_tag_gets_always(
        self, k8s_apis: K8sApis, second_team_namespace: str
    ) -> None:
        executor = _executor(k8s_apis)
        task = _task(
            "greet",
            # Never actually dispatched to completion in this test -- only
            # the created Job spec is inspected, then cancelled -- so this
            # doesn't need to be a real, pullable image.
            image="us-central1-docker.pkg.dev/my-gcp-project/catalog-products/fake-product:latest",
            team=second_team_namespace,
            service_account="default",
        )

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
            assert job.spec.template.spec.containers[0].image_pull_policy == "Always"
        finally:
            await executor.cancel(handle)

    async def test_bare_latest_tag_stays_if_not_present(
        self, k8s_apis: K8sApis, second_team_namespace: str
    ) -> None:
        executor = _executor(k8s_apis)
        # No "/" at all -- kind's own local-build convention (kind load
        # docker-image), which has no route to a real registry to satisfy
        # a forced re-pull.
        task = _task(
            "greet",
            image="fake-local-product:latest",
            team=second_team_namespace,
            service_account="default",
        )

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
            assert job.spec.template.spec.containers[0].image_pull_policy == "IfNotPresent"
        finally:
            await executor.cancel(handle)

    async def test_a_missing_image_fails_fast_as_image_not_found(
        self, k8s_apis: K8sApis, second_team_namespace: str
    ) -> None:
        """A real registry saying "no such tag" -- what a purged product's
        image looks like -- must fail the task within seconds, not sit in
        ImagePullBackOff until the task timeout."""
        executor = _executor(k8s_apis)
        task = _task(
            "greet",
            image="registry.k8s.io/pause:acyclix-does-not-exist",
            team=second_team_namespace,
            service_account="default",
        )

        handle = await executor.start(task)
        try:
            status = await wait_for_terminal(executor, handle, timeout=60)
        finally:
            await executor.cancel(handle)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "IMAGE_NOT_FOUND"
        assert status.error.retryable is False
        # Cleaned up like any finished Job.
        with pytest.raises(ApiException) as missing:
            k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
        assert missing.value.status == 404

    async def test_sha_pinned_tag_stays_if_not_present(
        self, k8s_apis: K8sApis, k8s_test_image: str, second_team_namespace: str
    ) -> None:
        """k8s_test_image is a real, immutable :local-tagged fixture image --
        the common case, and the one IfNotPresent's cheap-reuse behavior
        actually exists for."""
        executor = _executor(k8s_apis)
        task = _task(
            "greet", image=k8s_test_image, team=second_team_namespace, service_account="default"
        )

        handle = await executor.start(task)
        try:
            job = k8s_apis.batch.read_namespaced_job(handle["jobName"], second_team_namespace)
            assert job.spec.template.spec.containers[0].image_pull_policy == "IfNotPresent"
        finally:
            await executor.cancel(handle)
