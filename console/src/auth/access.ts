// SPDX-License-Identifier: MIT
/**
 * Who may act for a team, and who may see or manage an execution: the
 * console's authorization rules, in one place. kernel-api knows nothing of
 * teams, so these checks are what keep one team out of another's work.
 *
 * A team's people are maintainers or members (team_memberships.role). Any
 * member sees the team's work (executions, logs, Pods, its secrets' names)
 * and runs what it may run; a maintainer also manages the team: members
 * and roles, secrets, bots, raw DAGs and cancelling its runs. Everyone
 * signed in is a consumer of what's shared with their teams
 * (core/templates.ts). A platform admin may do all of it for any team.
 */
import { findSubmittedExecution, type SubmittedExecution } from "../db/queries.js";
import { ApiError } from "../apiError.js";

/** What the checks need of the caller (request.authUser). */
type AuthUser = { id?: string; teamNames: string[]; maintainerOf?: string[]; isAdmin: boolean } | undefined;

/** A member of the team, or a platform admin. */
export function canActForTeam(authUser: AuthUser, team: string): boolean {
  return authUser !== undefined && (authUser.isAdmin || authUser.teamNames.includes(team));
}

/** Throws the 403 (ApiError) when the caller can't act for `team`. */
export function ensureTeamMember(authUser: AuthUser, team: string): void {
  if (!canActForTeam(authUser, team)) {
    throw new ApiError(403, "FORBIDDEN", `Not a member of team "${team}", and not a platform admin.`);
  }
}

/** A maintainer of the team, or a platform admin. */
export function canMaintainTeam(authUser: AuthUser, team: string): boolean {
  return authUser !== undefined && (authUser.isAdmin || (authUser.maintainerOf ?? []).includes(team));
}

/** Throws the 403 (ApiError) when the caller can't manage `team`. */
export function ensureTeamMaintainer(authUser: AuthUser, team: string): void {
  if (!canMaintainTeam(authUser, team)) {
    const why = canActForTeam(authUser, team) ? "a member, not a maintainer," : "not a maintainer";
    throw new ApiError(403, "FORBIDDEN", `Managing team "${team}" takes a maintainer; you're ${why} and not a platform admin.`);
  }
}

/**
 * The submitted execution, when the caller may see it ("any" of its teams)
 * or manage it ("every" one: cancelling or retrying acts on all its teams'
 * tasks); otherwise its refusal (ApiError): 404 for no such execution, 403
 * for one the caller can't see or manage.
 */
export async function loadExecution(
  executionId: string,
  authUser: AuthUser,
  need: "any" | "every",
): Promise<SubmittedExecution> {
  const submitted = await findSubmittedExecution(executionId);
  if (!submitted) throw new ApiError(404, "NOT_FOUND", "Execution not found.");
  const member = (team: string) => canActForTeam(authUser, team);
  const maintainer = (team: string) => canMaintainTeam(authUser, team);
  // Whoever ran a template, too: a consumer who ran another team's template
  // sees, cancels and retries that run (core/templates.ts). A DAG submitted
  // as such stays its teams': cancelling it stops all of their tasks.
  const own = submitted.template !== null && authUser?.id !== undefined && submitted.submittedBy === authUser.id;
  // An execution always has a team; without one, "every" would hold for anyone.
  const allowed =
    own ||
    (need === "any" ? submitted.teams.some(member) : submitted.teams.length > 0 && submitted.teams.every(maintainer));
  if (!allowed) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      need === "any"
        ? "Not a member of any team this execution belongs to, and not a platform admin."
        : "Not a maintainer of every team this execution belongs to, and not a platform admin.",
    );
  }
  return submitted;
}
