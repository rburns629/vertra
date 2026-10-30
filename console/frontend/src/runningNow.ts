// SPDX-License-Identifier: MIT
import type { ExecutionSummary } from "./api";

/**
 * What a run is doing now, as a list or Home says it: "app-hosting.create,
 * attempt 2 of 3" (its first step claimed or running, the attempt only past
 * the first), "and N more" when several run at once; "" when none does (the
 * server lists none once a run has finished).
 */
export function runningNow(run: Pick<ExecutionSummary, "running">): string {
  const [first, ...rest] = run.running;
  if (!first) return "";
  const attempt = first.attempt > 1 ? `, attempt ${String(first.attempt)}${first.maxAttempts > 1 ? ` of ${String(first.maxAttempts)}` : ""}` : "";
  return `${first.taskId}.${first.action}${attempt}${rest.length > 0 ? `, and ${String(rest.length)} more` : ""}`;
}

/** How many of a run's steps succeeded, of all of them. */
export function stepsDone(run: Pick<ExecutionSummary, "steps">): { done: number; total: number } {
  const total = Object.values(run.steps).reduce((a, b) => a + b, 0);
  return { done: run.steps["SUCCEEDED"] ?? 0, total };
}

/**
 * A run's progress as Home says it: "2 of 5 steps done · now:
 * app-hosting.create, attempt 2 of 3". Counts, not a step number: with steps
 * skipped or running side by side there's no "step 3 of 5" that's true.
 */
export function runProgress(run: Pick<ExecutionSummary, "steps" | "running">): string {
  const { done, total } = stepsDone(run);
  const now = runningNow(run);
  return `${String(done)} of ${String(total)} steps done${now ? ` · now: ${now}` : ""}`;
}
