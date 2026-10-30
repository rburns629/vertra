// SPDX-License-Identifier: MIT
/**
 * Lets the kernel's scheduler read its steps' logs in team namespaces, and
 * nowhere else: one RoleBinding in each (k8s.ts's SCHEDULER_LOGS_BINDING),
 * binding its ServiceAccount to its logs-only ClusterRole, rather than a
 * cluster-wide binding that would let it read every Pod's logs, kube-system's
 * too. Written when a team is created or un-retired (kept when it's retired,
 * for its steps still running), and again in every policy resync
 * (policySync.ts). Only when the console manages team namespaces and the
 * kernel's role is configured (config.teamNamespaces.schedulerLogs); the
 * console's write fence accepts no other RoleBinding from it.
 */
import { config } from "./config.js";
import { listAllTeams } from "./db/queries.js";
import { writeSchedulerLogsBinding } from "./k8s.js";

function settings() {
  return config.teamNamespaces.manage ? config.teamNamespaces.schedulerLogs : null;
}

/** Writes it into one team's namespace, when the console keeps them. */
export async function ensureSchedulerLogsBinding(team: string): Promise<void> {
  const s = settings();
  if (s) await writeSchedulerLogsBinding(team, s.clusterRole, s.serviceAccount);
}

/** Writes it into every team's namespace that exists. Returns whether it
 * applies; throws (after trying every team) if any write failed. */
export async function syncSchedulerLogsBindings(): Promise<boolean> {
  const s = settings();
  if (!s) return false;
  const failed: string[] = [];
  for (const team of await listAllTeams()) {
    try {
      await writeSchedulerLogsBinding(team.name, s.clusterRole, s.serviceAccount);
    } catch {
      failed.push(team.name);
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't bind the scheduler's log reading in: ${failed.join(", ")}.`);
  return true;
}
