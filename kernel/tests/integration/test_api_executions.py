# SPDX-License-Identifier: MIT
"""Integration tests for the FastAPI routes — a real Postgres-backed app, driven over HTTP.

`get_db_session` is overridden to yield the test's `db_session` (rolled
back after the test) instead of a fresh per-request session, so these get
the same isolation guarantees as every other integration test while still
exercising the real ASGI app, routing, and response serialization.
"""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.execution import ExecutionSubmission
from app.contracts.task import TaskDefinition
from app.domain.errors import ValidationIssueCode
from app.scheduler.service import run_scheduler_tick
from tests.fakes import FakeExecutor


def _submission_payload(
    idempotency_key: str, *, tasks: list[TaskDefinition] | None = None
) -> dict[str, object]:
    submission = ExecutionSubmission(
        external_reference="demo-order-1",
        idempotency_key=idempotency_key,
        tasks=tasks
        if tasks is not None
        else [
            TaskDefinition(
                id="create-project",
                image="demo-project-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                inputs={"projectName": "demo-project"},
            ),
            TaskDefinition(
                id="deploy-application",
                image="demo-application-product:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["create-project"],
                inputs={"projectId": {"$fromTask": "create-project", "$output": "projectId"}},
            ),
        ],
    )
    return submission.model_dump(by_alias=True)


class TestDocumentedFieldNamesOnly:
    """The console authorizes a submission by its camelCase fields and forwards
    it unchanged, so the kernel must not read a Python name the console didn't
    look at: {"service_account": ...} would run a task as an identity the
    console never checked."""

    def _task(self, **fields: object) -> dict[str, object]:
        return {"id": "t", "image": "i:1", "action": "a", "team": "test-team", **fields}

    async def test_python_field_names_are_refused(self, api_client: AsyncClient) -> None:
        for fields in (
            {"service_account": "billing-sa"},
            {"serviceAccount": "default", "secret_refs": ["billing-key"]},
            {"serviceAccount": "default", "depends_on": []},
            {"serviceAccount": "default", "resources": {"memory_limit": "1Gi"}},
        ):
            response = await api_client.post(
                "/v1/executions", json={"name": "x", "tasks": [self._task(**fields)]}
            )
            assert response.status_code == 422, fields

    async def test_python_names_for_the_submission_itself_are_refused(
        self, api_client: AsyncClient
    ) -> None:
        response = await api_client.post(
            "/v1/executions",
            json={"external_reference": "x", "tasks": [self._task(serviceAccount="default")]},
        )
        assert response.status_code == 422

    async def test_documented_names_are_accepted(self, api_client: AsyncClient) -> None:
        response = await api_client.post(
            "/v1/executions",
            json={
                "name": "x",
                "tasks": [self._task(serviceAccount="default", resources={"memoryLimit": "1Gi"})],
            },
        )
        assert response.status_code == 201


class TestCreateExecution:
    async def test_new_submission_returns_201_pending_and_location_header(
        self, api_client: AsyncClient
    ) -> None:
        response = await api_client.post("/v1/executions", json=_submission_payload("idem-api-new"))

        assert response.status_code == 201
        body = response.json()
        assert body["state"] == "PENDING"
        assert "executionId" in body
        assert response.headers["location"] == f"/v1/executions/{body['executionId']}"

    async def test_duplicate_idempotency_key_returns_200_with_same_execution(
        self, api_client: AsyncClient
    ) -> None:
        payload = _submission_payload("idem-api-duplicate")

        first = await api_client.post("/v1/executions", json=payload)
        second = await api_client.post("/v1/executions", json=payload)

        assert first.status_code == 201
        assert second.status_code == 200
        assert first.json()["executionId"] == second.json()["executionId"]

    async def test_without_a_request_id_every_submission_is_a_new_run(
        self, api_client: AsyncClient
    ) -> None:
        payload = _submission_payload("unused")
        del payload["requestId"]

        first = await api_client.post("/v1/executions", json=payload)
        second = await api_client.post("/v1/executions", json=payload)

        assert first.status_code == 201
        assert second.status_code == 201
        assert first.json()["executionId"] != second.json()["executionId"]

    async def test_old_field_names_are_still_accepted(self, api_client: AsyncClient) -> None:
        # Stored DAGs (the console's Rerun) and older callers send these.
        payload = _submission_payload("idem-api-old-names")
        payload["externalReference"] = payload.pop("name")
        payload["idempotencyKey"] = payload.pop("requestId")

        first = await api_client.post("/v1/executions", json=payload)
        second = await api_client.post("/v1/executions", json=payload)

        assert first.status_code == 201
        assert second.status_code == 200
        assert first.json()["executionId"] == second.json()["executionId"]
        detail = await api_client.get(f"/v1/executions/{first.json()['executionId']}")
        assert detail.json()["name"] == "demo-order-1"

    async def test_old_and_new_name_together_is_refused(self, api_client: AsyncClient) -> None:
        payload = _submission_payload("idem-api-both")
        payload["externalReference"] = "something-else"

        response = await api_client.post("/v1/executions", json=payload)

        assert response.status_code == 422

    async def test_invalid_dag_returns_422_with_issue_details(
        self, api_client: AsyncClient
    ) -> None:
        cyclic_tasks = [
            TaskDefinition(
                id="a",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["b"],
            ),
            TaskDefinition(
                id="b",
                image="x:local",
                action="create",
                team="test-team",
                serviceAccount="default",
                dependsOn=["a"],
            ),
        ]
        response = await api_client.post(
            "/v1/executions", json=_submission_payload("idem-api-cycle", tasks=cyclic_tasks)
        )

        assert response.status_code == 422
        codes = {issue["code"] for issue in response.json()["detail"]}
        assert ValidationIssueCode.CYCLE_DETECTED.value in codes

    async def test_malformed_body_is_rejected_by_pydantic(self, api_client: AsyncClient) -> None:
        response = await api_client.post("/v1/executions", json={"tasks": []})
        assert response.status_code == 422


class TestReadExecution:
    async def test_returns_execution_with_initial_task_states(
        self, api_client: AsyncClient
    ) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_submission_payload("idem-api-read")
        )
        execution_id = create_response.json()["executionId"]

        response = await api_client.get(f"/v1/executions/{execution_id}")

        assert response.status_code == 200
        body = response.json()
        assert body["executionId"] == execution_id
        assert body["name"] == "demo-order-1"
        assert body["state"] == "PENDING"

        tasks_by_id = {task["taskId"]: task for task in body["tasks"]}
        assert tasks_by_id["create-project"]["state"] == "READY"
        assert tasks_by_id["create-project"]["outputs"] is None
        assert tasks_by_id["deploy-application"]["state"] == "BLOCKED"

    async def test_unknown_execution_returns_404(self, api_client: AsyncClient) -> None:
        response = await api_client.get("/v1/executions/00000000-0000-0000-0000-000000000000")
        assert response.status_code == 404

    async def test_reflects_live_scheduler_progress(
        self, api_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The API reads current DB state, not a snapshot — proven by advancing
        the execution directly (via the real scheduler loop, a fake executor)
        between two GETs and seeing the second reflect it."""
        create_response = await api_client.post(
            "/v1/executions", json=_submission_payload("idem-api-live-progress")
        )
        execution_id = create_response.json()["executionId"]

        before = await api_client.get(f"/v1/executions/{execution_id}")
        tasks_before = {t["taskId"]: t for t in before.json()["tasks"]}
        assert tasks_before["create-project"]["state"] == "READY"

        executor = FakeExecutor()
        await run_scheduler_tick(
            db_session,
            executor,
            owner="scheduler-1",
            lease_duration=timedelta(seconds=60),
            now=datetime.now(UTC),
        )

        after = await api_client.get(f"/v1/executions/{execution_id}")
        tasks_after = {t["taskId"]: t for t in after.json()["tasks"]}
        assert tasks_after["create-project"]["state"] == "RUNNING"


class TestReadExecutionEvents:
    async def test_returns_events_in_order(self, api_client: AsyncClient) -> None:
        create_response = await api_client.post(
            "/v1/executions", json=_submission_payload("idem-api-events")
        )
        execution_id = create_response.json()["executionId"]

        response = await api_client.get(f"/v1/executions/{execution_id}/events")

        assert response.status_code == 200
        body = response.json()
        events = body["events"]
        assert [event["eventType"] for event in events] == ["EXECUTION_CREATED"]
        assert events[0]["payload"] == {"taskCount": 2}
        assert body["nextCursor"] is None

    async def test_unknown_execution_returns_404(self, api_client: AsyncClient) -> None:
        response = await api_client.get(
            "/v1/executions/00000000-0000-0000-0000-000000000000/events"
        )
        assert response.status_code == 404


class TestHealth:
    async def test_live_reports_ok_without_touching_the_database(
        self, api_client: AsyncClient
    ) -> None:
        response = await api_client.get("/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    async def test_ready_reports_ok_when_the_database_is_reachable(
        self, api_client: AsyncClient
    ) -> None:
        response = await api_client.get("/health/ready")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestExecutionStates:
    async def test_answers_for_the_ids_that_exist(self, api_client: AsyncClient) -> None:
        created = await api_client.post("/v1/executions", json=_submission_payload("idem-states"))
        execution_id = created.json()["executionId"]
        missing = "00000000-0000-0000-0000-000000000000"

        response = await api_client.post(
            "/v1/executions/states", json={"ids": [execution_id, missing]}
        )

        assert response.status_code == 200
        assert response.json() == {"states": [{"executionId": execution_id, "state": "PENDING"}]}

    async def test_takes_more_ids_than_a_url_could_hold(self, api_client: AsyncClient) -> None:
        ids = [str(uuid.uuid4()) for _ in range(1000)]
        response = await api_client.post("/v1/executions/states", json={"ids": ids})
        assert response.status_code == 200

    async def test_refuses_more_than_a_batch(self, api_client: AsyncClient) -> None:
        ids = [str(uuid.uuid4()) for _ in range(1001)]
        response = await api_client.post("/v1/executions/states", json={"ids": ids})
        assert response.status_code == 422
