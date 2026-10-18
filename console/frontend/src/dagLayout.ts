// SPDX-License-Identifier: MIT
import type { TaskStatus } from "./api";

/**
 * Stages a task by longest path from a root (no `dependsOn` == stage 0),
 * the same layering a topological sort produces -- not re-validating
 * acyclicity here, since `dependsOn` already reaching a page using this
 * means kernel's own `validate_dag` (a real cycle check via topological
 * sort, see docs/architecture.md) already
 * accepted this exact graph at submission time. Shared by the Overview
 * tab's vertical timeline and the Graph tab's node layout -- same real
 * edges (`task.dependsOn`), two different renderings of them.
 */
export function computeStages(tasks: TaskStatus[]): TaskStatus[][] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const depthCache = new Map<string, number>();

  function depthOf(taskId: string): number {
    const cached = depthCache.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId);
    const depth =
      !task || task.dependsOn.length === 0 ? 0 : 1 + Math.max(...task.dependsOn.map(depthOf));
    depthCache.set(taskId, depth);
    return depth;
  }

  const stages: TaskStatus[][] = [];
  for (const task of tasks) {
    const depth = depthOf(task.taskId);
    (stages[depth] ??= []).push(task);
  }
  return stages;
}
