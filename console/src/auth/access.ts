// SPDX-License-Identifier: MIT
/**
 * Who may act for a team, and who may see or manage an execution: the
 * console's authorization rules, in one place. kernel-api knows nothing of
 * teams, so these checks are what keep one team out of another's work.
 */
import { findSubmittedExecution, type SubmittedExecution } from "../db/queries.js";
import { ApiError } from "../apiError.js";

/** What the checks need of the caller (request.authUser). */
type AuthUser = { teamNames: string[]; isAdmin: boolean } | undefined;

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
  // An execution always has a team; without one, "every" would hold for anyone.
  const allowed =
    need === "any" ? submitted.teams.some(member) : submitted.teams.length > 0 && submitted.teams.every(member);
  if (!allowed) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      need === "any"
        ? "Not a member of any team this execution belongs to, and not a platform admin."
        : "Not a member of every team this execution belongs to, and not a platform admin.",
    );
  }
  return submitted;
}
