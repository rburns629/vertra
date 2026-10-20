// SPDX-License-Identifier: MIT
import { ApiError } from "../apiError.js";

/**
 * A retired team is read-only (see schema.ts's teams.retiredAt): nothing new
 * may be registered, granted, minted or submitted for it. Each write calls
 * this once it has the team row.
 */
export function ensureNotRetired(team: { name: string; retiredAt: Date | null }): void {
  if (team.retiredAt) {
    throw new ApiError(
      409,
      "TEAM_RETIRED",
      `Team "${team.name}" is retired, so nothing new can be added or run for it. An admin can un-retire it.`,
    );
  }
}
