// SPDX-License-Identifier: MIT
/**
 * Keeps each team namespace's ResourceQuota and LimitRange (k8s.ts's
 * TEAM_QUOTA, TEAM_LIMITS): a ceiling on what all its steps may request
 * together, and on one step's memory, so one team can't take the cluster
 * from the others. The team's own limits, when an admin set them, else the
 * install's (teamNamespaces.quota). Written when a team is created or
 * un-retired, and again in every policy resync (policySync.ts), which puts
 * them into namespaces made before they existed and undoes any edit within
 * one interval. Only when the console manages team namespaces.
 */
import { config } from "./config.js";
import { findTeamByName, listAllTeams } from "./db/queries.js";
import { writeTeamQuota, type TeamQuota } from "./k8s.js";

/** The limits a team's namespace gets: its own, else the install's. */
export function effectiveQuota(team: { quota: TeamQuota | null }): TeamQuota {
  return team.quota ?? config.teamNamespaces.quota;
}

/** Writes them into one team's namespace, when the console keeps them. A
 * team being created (its namespace comes before its row) has no limits of
 * its own yet: the install's. */
export async function ensureTeamQuota(name: string): Promise<void> {
  if (!config.teamNamespaces.manage) return;
  const team = await findTeamByName(name);
  await writeTeamQuota(name, effectiveQuota({ quota: team?.quota ?? null }));
}

/** Writes them into every team's namespace that exists. Returns whether it
 * applies; throws (after trying every team) if any write failed. */
export async function syncTeamQuotas(): Promise<boolean> {
  if (!config.teamNamespaces.manage) return false;
  const failed: string[] = [];
  for (const team of await listAllTeams()) {
    try {
      await writeTeamQuota(team.name, effectiveQuota(team));
    } catch {
      failed.push(team.name);
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't write the resource limits into: ${failed.join(", ")}.`);
  return true;
}
