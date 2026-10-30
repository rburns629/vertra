// SPDX-License-Identifier: MIT
import type { ExecutionSummary } from "./api";

/**
 * What a run is doing now, as a list or Home says it: "app-hosting.create,
 * attempt 2 of 3" (its first step claimed or running, the attempt only past
 * the first), "and N more" when several run at once; "" when none does.
 */
export function runningNow(run: Pick<ExecutionSummary, "running">): string {
  const [first, ...rest] = run.running;
  if (!first) return "";
  const attempt = first.attempt > 1 ? `, attempt ${String(first.attempt)}${first.maxAttempts > 1 ? ` of ${String(first.maxAttempts)}` : ""}` : "";
  return `${first.taskId}.${first.action}${attempt}${rest.length > 0 ? `, and ${String(rest.length)} more` : ""}`;
}
