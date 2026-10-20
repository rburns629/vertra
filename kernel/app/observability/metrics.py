# SPDX-License-Identifier: MIT
"""Prometheus metrics.

Plain OpenMetrics/Prometheus exposition format rather than a vendor SDK
(e.g. Cloud Monitoring's custom-metrics API) — it's what self-hosted
Prometheus, GKE Managed Prometheus, and most other providers' Kubernetes
offerings all scrape natively, so the same instrumentation works unchanged
whether the kernel runs locally, on GKE, or on another cloud's cluster.
"""

from prometheus_client import Counter, Histogram

# Every task/execution lifecycle transition already passes through
# app.persistence.repositories.record_event (that's the whole point of
# funneling event-writing through one function) — hooking the counter in
# there covers claims, dispatches, successes, failures, retries, and
# cancellations without instrumenting each call site individually.
# Events are counted when their transaction commits, not when they're
# written: a pass that rolls back records nothing, and must count nothing.
# record_event queues each one on the session under this key, and
# session_scope counts them after the commit.
PENDING_EVENTS_KEY = "acyclix_pending_event_types"

EVENTS_TOTAL = Counter(
    "kernel_events_total",
    "Execution-kernel lifecycle events, by type.",
    ["event_type"],
)

HTTP_REQUESTS_TOTAL = Counter(
    "kernel_http_requests_total",
    "HTTP requests handled by kernel-api.",
    ["method", "path", "status"],
)

HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "kernel_http_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["method", "path"],
)

SCHEDULER_TICK_DURATION_SECONDS = Histogram(
    "kernel_scheduler_tick_duration_seconds",
    "Duration of one scheduler tick (claim + dispatch + poll).",
)

SCHEDULER_STATUS_READ_ERRORS_TOTAL = Counter(
    "kernel_scheduler_status_read_errors_total",
    "Reads of a running task's status that failed; the task stays running and is read again.",
)

SCHEDULER_TICK_ERRORS_TOTAL = Counter(
    "kernel_scheduler_tick_errors_total",
    "Scheduler ticks that raised and were skipped rather than crashing the process.",
)
