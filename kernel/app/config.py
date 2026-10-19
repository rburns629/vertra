# SPDX-License-Identifier: MIT
"""Runtime configuration, sourced from environment variables / a .env file.

Kept deliberately small: the kernel's only required external dependency is
Postgres, used as both the durable execution store and the task queue.
"""

from functools import lru_cache
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.contracts.task import TaskResources

# How many Kubernetes calls (Job starts, status reads) a scheduling pass has
# in flight at once; the scheduler's own default too (scheduler/service.py).
DEFAULT_EXECUTOR_CONCURRENCY = 16
DEFAULT_MAX_DISPATCH_FAILURES = 5


class TaskToleration(BaseModel):
    """One Pod toleration, as the Kubernetes Pod spec spells it."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    key: str | None = None
    operator: Literal["Equal", "Exists"] | None = None
    value: str | None = None
    effect: Literal["NoSchedule", "PreferNoSchedule", "NoExecute"] | None = None
    toleration_seconds: int | None = Field(default=None, alias="tolerationSeconds")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://localhost/execution_kernel"
    # Longest any one statement may run before it fails (create_engine).
    database_command_timeout_seconds: float = Field(default=60.0, gt=0)

    max_tasks_per_execution: int = 500

    # The longest the scheduler waits between passes when nothing has
    # happened. A watched change (a step finishing) wakes it sooner, and a
    # pass that made progress is followed by the next one at once.
    scheduler_poll_interval_seconds: float = 1.0
    lease_duration_seconds: int = 60
    # How many READY tasks one pass claims, and how many executor calls (Job
    # starts, status reads) it has in flight at once. The scheduler sizes its
    # thread pool from the latter (app/scheduler/__main__.py).
    scheduler_claim_limit: int = Field(default=50, gt=0)
    scheduler_executor_concurrency: int = Field(default=DEFAULT_EXECUTOR_CONCURRENCY, gt=0)
    # The most tasks claimed or running at once, across the platform and per
    # team (None: no limit), so a burst can't run up the bill or crowd out
    # other teams. Tasks over a limit wait, READY, for a later pass. Exact
    # with one scheduler; see claim_ready_tasks for several.
    # Between a failed task's attempts (domain/states.py's RetryBackoff):
    # this long after the first failure, doubling after each, capped.
    scheduler_retry_backoff_seconds: float = Field(default=5.0, ge=0)
    scheduler_retry_backoff_max_seconds: float = Field(default=300.0, ge=0)
    scheduler_max_running_tasks: int | None = Field(default=None, gt=0)
    scheduler_max_running_tasks_per_team: int | None = Field(default=None, gt=0)
    # A running step whose Job and Pod haven't changed (per the watch) isn't
    # re-read from the API, except once this often, in case an event was missed.
    kubernetes_watch_resync_seconds: int = Field(default=30, gt=0)

    # Arbitrary env vars applied uniformly to every dispatched task
    # container, regardless of which product image it runs — deployment-wide
    # configuration (e.g. GCP_TARGET_SERVICE_ACCOUNT, or
    # GOOGLE_APPLICATION_CREDENTIALS pointed at a task's own secretRefs
    # mount), not task-specific. A JSON object, e.g.
    # TASK_EXTRA_ENVIRONMENT='{"GCP_TARGET_SERVICE_ACCOUNT": "sa@project.iam.gserviceaccount.com"}'.
    # A flag that varies per task belongs in that task's own declared
    # `inputs` instead (see catalog/README.md) — this setting exists for
    # the other case, a knob every dispatched Pod needs the same value for.
    task_extra_environment: dict[str, str] = Field(default_factory=dict)

    # The Pod size for any part a task doesn't set itself (see TaskResources
    # in app/contracts/task.py), as JSON, e.g.
    # TASK_DEFAULT_RESOURCES='{"cpu": "100m", "memory": "256Mi"}'. Unset, a
    # task with no resources of its own requests nothing, and the cluster's
    # defaults apply: on GKE Autopilot, 0.5 vCPU and 2 GiB per Pod.
    task_default_resources: TaskResources | None = None

    # Where step Pods may run, applied to every one: a nodeSelector,
    # tolerations and an affinity, each as JSON in the Kubernetes Pod spec's
    # own shape. This is how a deployment sends steps to cheaper capacity
    # (Spot or preemptible nodes): see the per-cloud examples in the
    # execution-kernel chart's values.yaml. Empty: wherever the cluster puts them.
    task_node_selector: dict[str, str] = Field(default_factory=dict)
    task_tolerations: list[TaskToleration] = Field(default_factory=list)
    # The imagePullSecret every step Pod names, for images in private
    # registries: the console copies the platform's pull Secret into each
    # team namespace under this name (one Secret can hold any number of
    # registries; the kubelet uses the one it's pulling from). Empty: none.
    task_image_pull_secret: str = ""
    task_affinity: dict[str, Any] = Field(default_factory=dict)

    # The dispatch namespace itself isn't configured here — it comes from
    # each task's own `team` field (see app/contracts/task.py), since the
    # scheduler dispatches into more than one namespace.
    kubernetes_job_ttl_seconds: int = 3600

    # How long a task's image may keep failing to pull for a reason other
    # than "it doesn't exist" (registry auth, network) before the task fails
    # as IMAGE_PULL_FAILED. A missing image fails at once. Should stay well
    # under the default task timeout (300s), or the timeout fires first
    # with a less useful error.
    image_pull_grace_seconds: int = Field(default=120, gt=0)

    # Longest any one Kubernetes API call may take before it fails.
    kubernetes_request_timeout_seconds: float = Field(default=30.0, gt=0)
    # How many times in a row the scheduler retries starting the same attempt
    # after the start raised (each retry adopts the Job that start may have
    # created), before failing the attempt.
    scheduler_max_dispatch_failures: int = Field(default=DEFAULT_MAX_DISPATCH_FAILURES, gt=0)
    # A Job's activeDeadlineSeconds is its task's timeout plus this: a
    # backstop, so Kubernetes stops a Job the scheduler has lost track of
    # (the scheduler enforces the timeout itself). Covers pulling the image.
    kubernetes_job_deadline_grace_seconds: int = Field(default=600, ge=0)
    # Step Pods meet Pod Security's `restricted`: non-root (the image must
    # name a numeric non-root USER), a read-only root filesystem with a
    # writable /tmp, no capabilities, no privilege escalation, the runtime's
    # seccomp profile, no Kubernetes token. Off only for images that can't.
    task_pod_hardening: bool = True
    # A step's stored output: its last task_log_max_lines lines, at most
    # task_log_max_bytes, refreshed every task_log_refresh_seconds while it
    # runs (so a long step's progress shows) and once more when it ends.
    task_log_max_lines: int = Field(default=5000, gt=0)
    task_log_max_bytes: int = Field(default=1_048_576, gt=0)
    task_log_refresh_seconds: int = Field(default=60, gt=0)
    # Finished executions (with their tasks, outputs, logs and events) are
    # deleted this many days after their last event; 0 keeps them forever.
    # A deleted execution's requestId can then start a new one.
    execution_retention_days: int = Field(default=90, ge=0)

    # The sleeper (python -m app.sleeper, the chart's scaleDown CronJob):
    # scales the platform's Deployments to zero once nothing has happened for
    # sleeper_idle_after_seconds: no execution unfinished, none finished,
    # nobody using the console (its activity ConfigMap), kernel-api not
    # restarted (woken or upgraded). The databases go last.
    sleeper_namespace: str = ""
    sleeper_idle_after_seconds: int = Field(default=7200, gt=0)
    sleeper_deployments: list[str] = Field(default_factory=list)
    sleeper_database_deployments: list[str] = Field(default_factory=list)
    # Where each Deployment's copies are kept while asleep, for waking.
    sleeper_state_configmap: str = ""
    # The console's activity ConfigMap; empty: not consulted.
    sleeper_console_activity_configmap: str = ""
    # kernel-api's Pods: the newest one's start counts as activity.
    sleeper_api_pod_selector: str = ""
    # The sleeper's own CronJob: suspended while asleep, so it doesn't start a
    # Pod (on EKS Auto Mode, a node) every few minutes to find nothing to do.
    # Waking resumes it (acyclixctl wake). Empty: never suspended.
    sleeper_cronjob: str = ""
    # A scheduled sleep (--now) waits this long for unfinished executions.
    sleeper_scheduled_wait_seconds: int = Field(default=6 * 3600, gt=0)

    # The scheduler touches this file each time its loop comes round (and
    # while it waits for migrations); its liveness probe restarts it if the
    # file goes stale, i.e. if a pass hangs.
    scheduler_heartbeat_file: str = "/tmp/acyclix-scheduler-heartbeat"

    # Port kernel-scheduler serves /metrics on. Unused by kernel-api, which
    # exposes /metrics on its own main port instead — it already has an HTTP
    # server; the scheduler doesn't, so it needs a port of its own for a
    # Prometheus-compatible scraper (self-hosted Prometheus, GKE Managed
    # Prometheus, or any other OpenMetrics-compatible collector) to reach it.
    metrics_port: int = 9090

    # Who may call kernel-api's /v1 routes (app/api/auth.py). Each request
    # carries a Kubernetes ServiceAccount token issued for this audience;
    # a TokenReview checks it, and its username must be listed in
    # api_allowed_callers ("system:serviceaccount:<namespace>:<name>": the
    # console's). An empty list refuses everyone. "disabled" skips the
    # check, for running kernel-api outside a cluster in development only.
    api_auth: Literal["tokenreview", "disabled"] = "tokenreview"
    api_token_audience: str = "acyclix-kernel-api"
    api_allowed_callers: list[str] = Field(default_factory=list)


@lru_cache
def get_settings() -> Settings:
    return Settings()
