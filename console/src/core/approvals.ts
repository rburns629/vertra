// SPDX-License-Identifier: MIT
/**
 * Approvals: a step whose product.yaml says `approval` (always, or for other
 * teams' runs), or that aims at a target its team's allowedTargets let
 * through only with one, waits in AWAITING_APPROVAL (core/executions.ts sets
 * approvalRequired; the kernel holds it). A maintainer of the step's team
 * approves or declines it, never whoever submitted the run: two people, so
 * one can't both ask and agree. Each decision is audited (audit.ts records
 * the method, the execution, the task and `approve`), and the kernel records
 * who decided in the step's events. Nobody deciding within the scheduler's
 * approval timeout fails it with APPROVAL_EXPIRED.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { canMaintainTeam, loadExecution } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { findTeamByName, findUserById, listAllTeams } from "../db/queries.js";
import { decideApproval, getExecution, listAwaitingApproval } from "../kernel/client.js";
import { ensureNotRetired } from "./retired.js";

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** Each task's team, from the DAG as submitted. */
export function taskTeams(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const tasks = typeof payload === "object" && payload !== null && Array.isArray((payload as { tasks?: unknown }).tasks)
    ? (payload as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const { id, team } = task as { id?: unknown; team?: unknown };
    if (typeof id === "string" && typeof team === "string") out.set(id, team);
  }
  return out;
}

/** Whether the caller may decide on a step of `team` in a run `submittedBy` submitted. */
export function mayDecide(caller: AuthUser, team: string, submittedBy: string | null): boolean {
  return canMaintainTeam(caller, team) && submittedBy !== caller.id;
}

export async function decide(
  caller: AuthUser | undefined,
  executionId: string,
  taskId: string,
  approve: boolean,
  reason: string,
) {
  const who = signedIn(caller);
  const submitted = await loadExecution(executionId, who, "any");
  const team = taskTeams(submitted.payload).get(taskId);
  if (team === undefined) throw new ApiError(404, "NOT_FOUND", `No step "${taskId}" in this execution.`);
  if (!canMaintainTeam(who, team)) {
    throw new ApiError(403, "FORBIDDEN", `Only a maintainer of ${team} may approve or decline its steps.`);
  }
  if (submitted.submittedBy === who.id) {
    throw new ApiError(403, "FORBIDDEN", `You submitted this run, so another maintainer of ${team} decides.`);
  }
  const owner = await findTeamByName(team);
  if (owner) ensureNotRetired(owner);
  const task = (await getExecution(executionId)).tasks.find((t) => t.taskId === taskId);
  if (task?.state !== "AWAITING_APPROVAL") {
    throw new ApiError(409, "NOT_AWAITING_APPROVAL", `Step "${taskId}" isn't awaiting approval.`, Code.FailedPrecondition);
  }
  return decideApproval(executionId, taskId, approve, `user:${who.id}`, approve ? "" : reason);
}

/** The steps awaiting approval in the teams the caller maintains (every team, for an admin). */
export async function pendingApprovals(caller: AuthUser | undefined) {
  const who = signedIn(caller);
  const teams = who.isAdmin ? (await listAllTeams()).map((t) => t.name) : who.maintainerOf;
  const awaiting = await listAwaitingApproval(teams);
  const emails = new Map<string, string>();
  for (const id of new Set(awaiting.map((a) => a.requestedBy).filter((r) => r.startsWith("user:")))) {
    emails.set(id, (await findUserById(id.slice("user:".length)))?.email ?? "(deleted account)");
  }
  return awaiting.map((a) => ({
    ...a,
    requestedBy: emails.get(a.requestedBy) ?? "",
    canDecide: a.requestedBy !== `user:${who.id}`,
  }));
}
