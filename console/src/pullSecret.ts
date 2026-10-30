// SPDX-License-Identifier: MIT
/**
 * Copies the platform's registry pull Secret into every team namespace
 * (k8s.ts's TEAM_PULL_SECRET), so the kubelet can pull steps' images from
 * private registries. The console has the credential as a mounted file
 * (config.teamPullSecretFile) and never reads a Secret through the API.
 * Written when a team is created or un-retired, and again in every policy
 * resync (policySync.ts), which carries a rotated credential to every team
 * within one interval. One Secret holds any number of registries.
 *
 * With a federated registry (registryFederation.ts), the Secret is minted
 * instead: a fresh short-lived token for those hosts beside any static
 * credentials, written here and, for the verify and scan Jobs, in the
 * platform's namespace, every resync.
 */
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { listAllTeams } from "./db/queries.js";
import { writeRegistryTokenSecret, writeTeamPullSecret } from "./k8s.js";
import { federatedDockerConfig, federationEnabled } from "./registryFederation.js";

async function readPullSecret(): Promise<string | null> {
  if (federationEnabled()) return federatedDockerConfig();
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
  if (federationEnabled() && config.registryFederation.tokenSecret) {
    await writeRegistryTokenSecret(config.platformNamespace, config.registryFederation.tokenSecret, dockerConfigJson);
  }
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
