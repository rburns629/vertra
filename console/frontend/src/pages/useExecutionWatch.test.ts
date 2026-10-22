// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
/**
 * The execution detail page's watch (useExecutionWatch.ts): it follows the
 * stream, stops once the execution has finished, reopens a stream that ends
 * or drops unfinished, backs off when it can't connect, gives up on a 4xx,
 * and resume() starts it again so a retried execution keeps updating.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getExecutionEvents, getExecutionLogs, watchExecution, type ExecutionDetail } from "../api";
import { RETRY_MAX_MS, RETRY_MIN_MS, useExecutionWatch } from "./useExecutionWatch";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  watchExecution: vi.fn(),
  getExecutionEvents: vi.fn(),
  getExecutionLogs: vi.fn(),
}));

const detail = (state: string) => ({ executionId: "e", state }) as unknown as ExecutionDetail;

/** Each call to watchExecution plays the next script: its states, then the error it ends with, if any. */
type Script = { states: string[]; ending?: Error };
let scripts: Script[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  scripts = [];
  vi.mocked(watchExecution).mockImplementation(async function* () {
    const script = scripts.shift() ?? { states: [] };
    for (const state of script.states) yield detail(state);
    if (script.ending) throw script.ending;
  });
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

describe("useExecutionWatch", () => {
  it("follows the stream and stops once the execution has finished", async () => {
    scripts = [{ states: ["RUNNING", "SUCCEEDED"] }];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(0);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
    // Events and logs fetched with each frame.
    expect(getExecutionLogs).toHaveBeenCalledTimes(2);
    await advance(RETRY_MAX_MS * 2);
    expect(watchExecution).toHaveBeenCalledTimes(1);
  });

  it("reopens a stream that ends or drops before the execution finishes", async () => {
    scripts = [
      { states: ["RUNNING"] }, // the server's limit per stream
      { states: ["RUNNING"], ending: new ApiError(500, "dropped") }, // a load balancer's timeout
      { states: ["SUCCEEDED"] },
    ];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(0);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
    expect(result.current.error).toBeNull();
    expect(watchExecution).toHaveBeenCalledTimes(3);
  });

  it("shows why it can't connect, and tries again less and less often", async () => {
    const down = new ApiError(503, "The console is restarting.");
    scripts = [{ states: [], ending: down }, { states: [], ending: down }, { states: ["SUCCEEDED"] }];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(0);
    expect(result.current.error).toBe("The console is restarting.");
    await advance(RETRY_MIN_MS);
    expect(watchExecution).toHaveBeenCalledTimes(2);
    await advance(RETRY_MIN_MS);
    expect(watchExecution).toHaveBeenCalledTimes(2); // now waiting twice as long
    await advance(RETRY_MIN_MS);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
    expect(result.current.error).toBeNull();
  });

  it("waits before reopening a stream that ends without sending anything", async () => {
    scripts = [{ states: [] }, { states: [] }, { states: ["SUCCEEDED"] }];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(0);
    expect(watchExecution).toHaveBeenCalledTimes(1);
    await advance(RETRY_MIN_MS);
    expect(watchExecution).toHaveBeenCalledTimes(2);
    await advance(RETRY_MIN_MS);
    expect(watchExecution).toHaveBeenCalledTimes(2);
    await advance(RETRY_MIN_MS);
    expect(watchExecution).toHaveBeenCalledTimes(3);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
  });

  it("gives up on a 4xx", async () => {
    scripts = [{ states: [], ending: new ApiError(403, "Not a member.") }];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(RETRY_MAX_MS * 2);
    expect(result.current.error).toBe("Not a member.");
    expect(watchExecution).toHaveBeenCalledTimes(1);
  });

  it("starts again on resume(), and follows the execution until it finishes", async () => {
    scripts = [{ states: ["FAILED"] }];
    const { result } = renderHook(() => useExecutionWatch("e"));
    await advance(0);
    expect(result.current.execution?.state).toBe("FAILED");

    scripts = [{ states: ["RUNNING", "SUCCEEDED"] }]; // a task was retried
    act(() => {
      result.current.resume();
    });
    await advance(0);
    expect(result.current.execution?.state).toBe("SUCCEEDED");
    expect(watchExecution).toHaveBeenCalledTimes(2);
  });
});
