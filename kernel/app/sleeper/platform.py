# SPDX-License-Identifier: MIT
"""The platform's Deployments, as the sleeper sees and changes them.

Only through the scale subresource (which can change nothing but a
count), and one ConfigMap of its own for the counts to wake to: the chart's
Role grants nothing else, so a stolen sleeper token can't change what any
Deployment runs.
"""

import json
from datetime import datetime

from kubernetes import client
from kubernetes.client.exceptions import ApiException

# The ConfigMap key holding {deployment: replicas} while asleep; acyclixctl
# wake reads the same key.
AWAKE_REPLICAS_KEY = "awakeReplicas"


class Platform:
    def __init__(self, namespace: str, *, timeout_seconds: float) -> None:
        self._namespace = namespace
        self._apps = client.AppsV1Api()
        self._core = client.CoreV1Api()
        self._batch = client.BatchV1Api()
        self._timeout = timeout_seconds

    def replicas(self, names: list[str]) -> dict[str, int]:
        """Each existing Deployment's replicas (a missing one is left out)."""
        found: dict[str, int] = {}
        for name in names:
            try:
                scale = self._apps.read_namespaced_deployment_scale(
                    name, self._namespace, _request_timeout=self._timeout
                )
            except ApiException as error:
                if error.status == 404:
                    continue
                raise
            found[name] = (scale.spec.replicas if scale.spec else 0) or 0
        return found

    def newest_pod_start(self, selector: str) -> datetime | None:
        """When the newest running Pod matching ``selector`` started."""
        if not selector:
            return None
        pods = self._core.list_namespaced_pod(
            self._namespace, label_selector=selector, _request_timeout=self._timeout
        )
        starts = [
            pod.status.start_time for pod in pods.items if pod.status and pod.status.start_time
        ]
        return max(starts) if starts else None

    def console_activity(self, configmap: str) -> datetime | None:
        """The console's last use, from its activity ConfigMap."""
        if not configmap:
            return None
        try:
            data = self._core.read_namespaced_config_map(
                configmap, self._namespace, _request_timeout=self._timeout
            ).data
        except ApiException as error:
            if error.status == 404:
                return None
            raise
        value = (data or {}).get("lastActivityAt")
        return datetime.fromisoformat(value) if value else None

    def sleep(self, awake: dict[str, int], order: list[str], state_configmap: str) -> None:
        """Records ``awake`` (what to wake to), then scales each Deployment in
        ``order`` to zero. Recorded first, so a sleep cut short still wakes."""
        body = {"data": {AWAKE_REPLICAS_KEY: json.dumps(awake, sort_keys=True)}}
        self._core.patch_namespaced_config_map(
            state_configmap, self._namespace, body, _request_timeout=self._timeout
        )
        for name in order:
            self._apps.patch_namespaced_deployment_scale(
                name, self._namespace, {"spec": {"replicas": 0}}, _request_timeout=self._timeout
            )

    def suspend(self, cronjob: str) -> None:
        """Suspends the sleeper's own CronJob (waking resumes it)."""
        if not cronjob:
            return
        self._batch.patch_namespaced_cron_job(
            cronjob, self._namespace, {"spec": {"suspend": True}}, _request_timeout=self._timeout
        )
