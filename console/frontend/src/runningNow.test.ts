// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { runProgress, runningNow } from "./runningNow";

const step = (taskId: string, attempt = 1, maxAttempts = 1) => ({ taskId, action: "create", attempt, maxAttempts });

describe("runningNow", () => {
  it("names the step running, with its attempt past the first", () => {
    expect(runningNow({ running: [] })).toBe("");
    expect(runningNow({ running: [step("app-hosting")] })).toBe("app-hosting.create");
    expect(runningNow({ running: [step("app-hosting", 2, 3)] })).toBe("app-hosting.create, attempt 2 of 3");
    expect(runningNow({ running: [step("a"), step("b"), step("c")] })).toBe("a.create, and 2 more");
  });
});

describe("runProgress", () => {
  it("counts the steps done, and says what runs now", () => {
    expect(runProgress({ steps: { SUCCEEDED: 1, RUNNING: 1, PENDING: 1 }, running: [step("app-hosting", 2, 3)] })).toBe(
      "1 of 3 steps done · now: app-hosting.create, attempt 2 of 3",
    );
    expect(runProgress({ steps: { SUCCEEDED: 2, PENDING: 1 }, running: [] })).toBe("2 of 3 steps done");
  });

  it("claims no step number with steps skipped or running side by side", () => {
    // Two run at once, one was skipped: "step 2 of 5" would be wrong either way.
    expect(runProgress({ steps: { SUCCEEDED: 1, SKIPPED: 1, RUNNING: 2, PENDING: 1 }, running: [step("a"), step("b")] })).toBe(
      "1 of 5 steps done · now: a.create, and 1 more",
    );
  });
});
