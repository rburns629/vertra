// SPDX-License-Identifier: MIT
/**
 * Keeps a default-deny NetworkPolicy in every team namespace (k8s.ts's
 * TEAM_NETWORK_POLICY), so one team's steps can't reach another team's
 * Pods, and, with the gateway on, one letting the gateway reach the Pods
 * the team labels as API backends (TEAM_GATEWAY_INGRESS). Written when a team is created or un-retired, and again in every
 * policy resync (policySync.ts), which puts it into namespaces made before
 * it existed and undoes any edit within one interval. Only when the console
 * manages team namespaces (config.teamNamespaces); otherwise whoever makes
 * them adds it.
 */
import { config } from "./config.js";
import { listAllTeams } from "./db/queries.js";
import { writeTeamNetworkPolicy } from "./k8s.js";

function applies(): boolean {
  return config.teamNamespaces.manage && config.teamNamespaces.defaultDenyIngress;
}

/** Writes it into one team's namespace, when the console keeps them. */
export async function ensureTeamNetworkPolicy(team: string): Promise<void> {
  if (applies()) await writeTeamNetworkPolicy(team, config.teamNamespaces.gatewayIngress);
}

/** Writes it into every team's namespace that exists. Returns whether it
 * applies; throws (after trying every team) if any write failed. */
export async function syncTeamNetworkPolicies(): Promise<boolean> {
  if (!applies()) return false;
  const failed: string[] = [];
  for (const team of await listAllTeams()) {
    try {
      await writeTeamNetworkPolicy(team.name, config.teamNamespaces.gatewayIngress);
    } catch {
      failed.push(team.name);
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't write the network policy into: ${failed.join(", ")}.`);
  return true;
}
