// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
/**
 * The execution detail page's polling (useExecutionPolling.ts): it stops once
 * the execution has finished, and resume() starts it again, so a retried
 * execution keeps updating instead of freezing on its last state.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExecution, getExecutionEvents, getExecutionLogs, type ExecutionDetail } from "../api";
import { POLL_INTERVAL_MS, useExecutionPolling } from "./useExecutionPolling";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getExecution: vi.fn(),
  getExecutionEvents: vi.fn(),
  getExecutionLogs: vi.fn(),
}));

let state = "FAILED";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getExecution).mockImplementation(() => Promise.resolve({ executionId: "e", state } as unknown as ExecutionDetail));
  vi.mocked(getExecutionEvents).mockResolvedValue({ events: [], nextCursor: null });
  vi.mocked(getExecutionLogs).mockResolvedValue({ tasks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useExecutionPolling", () => {
  it("stops polling once the execution has finished", async () => {
    state = "FAILED";
    const { result } = renderHook(() => useExecutionPolling("e"));
    await advance(0);
    expect(result.current.execution?.state).toBe("FAILED");
    const calls = vi.mocked(getExecution).mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3);
    expect(vi.mocked(getExecution).mock.calls.length).toBe(calls);
  });

  it("starts again on resume(), and follows the execution until it finishes", async () => {
    state = "FAILED";
    const { result } = renderHook(() => useExecutionPolling("e"));
    await advance(0);

    state = "RUNNING"; // a task was retried
    act(() => {
      result.current.resume();
    });
    await advance(0);
    expect(result.current.execution?.state).toBe("RUNNING");

    state = "SUCCEEDED";
    await advance(POLL_INTERVAL_MS);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
  });
});
