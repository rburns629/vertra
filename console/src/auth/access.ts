// SPDX-License-Identifier: MIT
/**
 * Who may act for a team, and who may see or manage an execution: the
 * console's authorization rules, in one place. kernel-api knows nothing of
 * teams, so these checks are what keep one team out of another's work.
 */
import type { FastifyReply } from "fastify";
import { findSubmittedExecution, type SubmittedExecution } from "../db/queries.js";

/** What the checks need of the caller (request.authUser). */
type AuthUser = { teamNames: string[]; isAdmin: boolean } | undefined;

/** A member of the team, or a platform admin. */
export function canActForTeam(authUser: AuthUser, team: string): boolean {
  return authUser !== undefined && (authUser.isAdmin || authUser.teamNames.includes(team));
}

/** Sends the 403 when the caller can't act for `team`; returns whether it did. */
export function replyIfNotTeamMember(authUser: AuthUser, team: string, reply: FastifyReply): boolean {
  if (canActForTeam(authUser, team)) return false;
  reply.code(403).send({
    error: "FORBIDDEN",
    message: `Not a member of team "${team}", and not a platform admin.`,
  });
  return true;
}

/**
 * The execution, when the caller may see it ("any": a member of one of its
 * teams) or manage it ("every": a member of all of them, since cancelling
 * stops every team's tasks), or an admin. Otherwise sends the 404 or 403
 * and returns undefined.
 */
export async function loadExecutionOrReply(
  executionId: string,
  authUser: AuthUser,
  reply: FastifyReply,
  need: "any" | "every",
): Promise<SubmittedExecution | undefined> {
  const submitted = await findSubmittedExecution(executionId);
  if (!submitted) {
    reply.code(404).send({ error: "NOT_FOUND", message: "Execution not found." });
    return undefined;
  }
  const member = (team: string) => canActForTeam(authUser, team);
  // An execution always has a team; without one, "every" would hold for anyone.
  const allowed =
    need === "any" ? submitted.teams.some(member) : submitted.teams.length > 0 && submitted.teams.every(member);
  if (!allowed) {
    reply.code(403).send({
      error: "FORBIDDEN",
      message:
        need === "any"
          ? "Not a member of any team this execution belongs to, and not a platform admin."
          : "Not a member of every team this execution belongs to, and not a platform admin.",
    });
    return undefined;
  }
  return submitted;
}
