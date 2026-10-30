// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { runningNow } from "./runningNow";

const step = (taskId: string, attempt = 1, maxAttempts = 1) => ({ taskId, action: "create", attempt, maxAttempts });

describe("runningNow", () => {
  it("names the step running, with its attempt past the first", () => {
    expect(runningNow({ running: [] })).toBe("");
    expect(runningNow({ running: [step("app-hosting")] })).toBe("app-hosting.create");
    expect(runningNow({ running: [step("app-hosting", 2, 3)] })).toBe("app-hosting.create, attempt 2 of 3");
    expect(runningNow({ running: [step("a"), step("b"), step("c")] })).toBe("a.create, and 2 more");
  });
});
