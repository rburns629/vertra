// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getExecution,
  getExecutionEvents,
  getExecutionLogs,
  type ExecutionDetail,
  type ExecutionEvent,
  type TaskLogs,
} from "../api";

export const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
export const POLL_INTERVAL_MS = 2000;

export interface ExecutionPolling {
  execution: ExecutionDetail | null;
  events: ExecutionEvent[];
  logs: TaskLogs[];
  error: string | null;
  /** Poll now, and keep polling even if it had stopped: after a retry or a
   * cancel, a finished execution can be live again. */
  resume: () => void;
}

/**
 * An execution's status, event log and container output, polled every 2s
 * until it finishes. No WebSocket: a short poll against the same endpoints,
 * stopped once there's nothing left to change, or on a 4xx, which asking
 * again won't change. Anything else (a network blip, a console restart, a
 * 5xx) keeps polling, and the next good answer clears the error. Events are
 * fetched from a cursor; logs are a full snapshot each time, since each
 * task's row is overwritten per attempt.
 */
export function useExecutionPolling(id: string): ExecutionPolling {
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [logs, setLogs] = useState<TaskLogs[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumped by resume(): starts the polling effect again.
  const [round, setRound] = useState(0);
  const cursorRef = useRef<number | undefined>(undefined);
  const fetchingRef = useRef(false);

  // A different execution starts from nothing.
  useEffect(() => {
    setExecution(null);
    setEvents([]);
    setLogs([]);
    setError(null);
    cursorRef.current = undefined;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    async function tick(): Promise<void> {
      if (cancelled || fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const [detail, eventPage, logsPage] = await Promise.all([
          getExecution(id),
          getExecutionEvents(id, cursorRef.current),
          getExecutionLogs(id),
        ]);
        if (cancelled) return;
        setExecution(detail);
        setLogs(logsPage.tasks);
        setError(null);
        if (eventPage.events.length > 0) {
          setEvents((prev) => [...prev, ...eventPage.events]);
          cursorRef.current = eventPage.events[eventPage.events.length - 1]?.id;
        }
        if (TERMINAL_STATES.has(detail.state)) clearInterval(intervalId);
      } catch (err) {
        if (cancelled) return;
        const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
        setError(err instanceof ApiError ? err.message : "Couldn't reach the console. Retrying every few seconds.");
        if (permanent) clearInterval(intervalId);
      } finally {
        fetchingRef.current = false;
      }
    }

    void tick();
    intervalId = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [id, round]);

  const resume = useCallback(() => {
    setRound((r) => r + 1);
  }, []);

  return { execution, events, logs, error, resume };
}
