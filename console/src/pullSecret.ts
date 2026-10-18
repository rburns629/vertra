// SPDX-License-Identifier: MIT
/**
 * Copies the platform's registry pull Secret into every team namespace
 * (k8s.ts's TEAM_PULL_SECRET), so the kubelet can pull steps' images from
 * private registries. The console has the credential as a mounted file
 * (config.teamPullSecretFile) and never reads a Secret through the API.
 * Written when a team is created or un-retired, and again in every policy
 * resync (policySync.ts), which carries a rotated credential to every team
 * within one interval. One Secret holds any number of registries.
 */
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { listAllTeams } from "./db/queries.js";
import { writeTeamPullSecret } from "./k8s.js";

async function readPullSecret(): Promise<string | null> {
  if (!config.teamPullSecretFile) return null;
  return readFile(config.teamPullSecretFile, "utf8");
}

/** Copies it into one team's namespace, when configured. */
export async function copyPullSecret(team: string): Promise<void> {
  const dockerConfigJson = await readPullSecret();
  if (dockerConfigJson !== null) await writeTeamPullSecret(team, dockerConfigJson);
}

/** Copies it into every team's namespace that exists. Returns whether it's
 * configured; throws (after trying every team) if any write failed. */
export async function syncPullSecrets(): Promise<boolean> {
  const dockerConfigJson = await readPullSecret();
  if (dockerConfigJson === null) return false;
  const failed: string[] = [];
  for (const team of await listAllTeams()) {
    try {
      await writeTeamPullSecret(team.name, dockerConfigJson);
    } catch {
      failed.push(team.name);
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't copy the pull Secret into: ${failed.join(", ")}.`);
  return true;
}
