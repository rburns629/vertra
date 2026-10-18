# SPDX-License-Identifier: MIT
"""Integration tests for the two fake product containers — a real Kubernetes cluster
(kind), real images, not mocks.

These prove each product implements its own side of the contract
correctly, and that the two compose: project-product's real output can
become application-product's real input by hand, which is exactly what the
scheduler automates in tests/end_to_end/test_two_task_chain.py.
"""

from app.executors.base import ExecutorRunState, ResolvedTask
from app.executors.kubernetes import KubernetesExecutor
from tests.conftest import K8sApis
from tests.integration.executor_helpers import wait_for_terminal

# Must be a namespace that actually exists in the test cluster (see
# tests.conftest.K8S_NAMESPACE) -- this is what KubernetesExecutor
# dispatches into.
TEST_TEAM = "execution-kernel"


def _task(image: str, action: str, inputs: dict[str, object], task_key: str) -> ResolvedTask:
    return ResolvedTask(
        execution_id="exec-demo",
        task_key=task_key,
        image=image,
        action=action,
        attempt=1,
        resolved_inputs=inputs,
        timeout_seconds=60,
        team=TEST_TEAM,
        service_account="default",
    )


class TestProjectProduct:
    async def test_create_with_valid_input_succeeds(
        self, k8s_apis: K8sApis, k8s_project_product_image: str
    ) -> None:
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)
        task = _task(
            k8s_project_product_image, "create", {"projectName": "demo-project"}, "create-project"
        )

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle)

        assert status.state is ExecutorRunState.SUCCEEDED
        assert status.outputs == {"projectId": "demo-project-123"}

    async def test_create_without_project_name_fails(
        self, k8s_apis: K8sApis, k8s_project_product_image: str
    ) -> None:
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)
        task = _task(k8s_project_product_image, "create", {}, "create-project")

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "MISSING_INPUT"
        assert status.error.retryable is False

    async def test_unsupported_action_fails(
        self, k8s_apis: K8sApis, k8s_project_product_image: str
    ) -> None:
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)
        task = _task(
            k8s_project_product_image, "delete", {"projectName": "demo-project"}, "create-project"
        )

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "UNSUPPORTED_ACTION"


class TestApplicationProduct:
    async def test_create_with_valid_project_id_succeeds(
        self, k8s_apis: K8sApis, k8s_application_product_image: str
    ) -> None:
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)
        task = _task(
            k8s_application_product_image,
            "create",
            {"projectId": "demo-project-123"},
            "deploy-application",
        )

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle)

        assert status.state is ExecutorRunState.SUCCEEDED
        assert status.outputs == {"applicationUrl": "https://demo.example"}

    async def test_create_without_project_id_fails(
        self, k8s_apis: K8sApis, k8s_application_product_image: str
    ) -> None:
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)
        task = _task(k8s_application_product_image, "create", {}, "deploy-application")

        handle = await executor.start(task)
        status = await wait_for_terminal(executor, handle)

        assert status.state is ExecutorRunState.FAILED
        assert status.error is not None
        assert status.error.code == "MISSING_INPUT"
        assert status.error.retryable is False


class TestProductsComposeManually:
    async def test_project_output_feeds_application_input(
        self,
        k8s_apis: K8sApis,
        k8s_project_product_image: str,
        k8s_application_product_image: str,
    ) -> None:
        """The manual version of the chain the scheduler automates:
        run project-product, take its real output, hand it to application-product."""
        executor = KubernetesExecutor(batch_api=k8s_apis.batch, core_api=k8s_apis.core)

        create_project = _task(
            k8s_project_product_image, "create", {"projectName": "demo-project"}, "create-project"
        )
        project_handle = await executor.start(create_project)
        project_status = await wait_for_terminal(executor, project_handle)
        assert project_status.state is ExecutorRunState.SUCCEEDED
        assert project_status.outputs is not None
        project_id = project_status.outputs["projectId"]

        deploy_application = _task(
            k8s_application_product_image,
            "create",
            {"projectId": project_id},
            "deploy-application",
        )
        application_handle = await executor.start(deploy_application)
        application_status = await wait_for_terminal(executor, application_handle)

        assert application_status.state is ExecutorRunState.SUCCEEDED
        assert application_status.outputs == {"applicationUrl": "https://demo.example"}
