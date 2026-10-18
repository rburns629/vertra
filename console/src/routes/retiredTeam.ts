// SPDX-License-Identifier: MIT
import type { FastifyReply } from "fastify";

/**
 * A retired team is read-only (see schema.ts's teams.retiredAt): nothing new
 * may be registered, granted, minted or submitted for it. Each write route
 * calls this once it has the team row; it sends the 409 itself and returns
 * true when the caller should stop.
 */
export function replyIfRetired(
  team: { name: string; retiredAt: Date | null },
  reply: FastifyReply,
): boolean {
  if (!team.retiredAt) return false;
  reply.code(409).send({
    error: "TEAM_RETIRED",
    message: `Team "${team.name}" is retired, so nothing new can be added or run for it. An admin can un-retire it.`,
  });
  return true;
}
