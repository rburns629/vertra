// SPDX-License-Identifier: MIT
/**
 * Keeps the cluster's copy of who may run as what current. The console
 * decides which ServiceAccount and Secrets a task may use (identityRefusal
 * in routes/executions.ts); helm/charts/execution-kernel/templates/
 * identity-policy.yaml makes the Kubernetes API server enforce the same rule
 * on every Job the scheduler creates, from two literals held in the policy
 * itself. This writes them, from the database, whenever products or secrets
 * change and at startup:
 *
 * - `products`: one entry per registered product, matched the way
 *   identityRefusal matches a task: its team (its namespace; "" for a
 *   platform product), its image repository (any tag or digest, read as
 *   imageRepository reads it, which the policy's CEL does too), its action,
 *   and the ServiceAccount it runs as ("default" when it declares none).
 * - `teamSecrets`: each team's registered secret names, comma-separated (CEL
 *   wants every value in a literal map to be one type; Secret names can't
 *   hold commas). A registered product may mount any of its namespace's.
 */
import { config } from "./config.js";
import { listProductIdentities, listTeamSecretNames, type ProductIdentity } from "./db/queries.js";
import { imageRepository } from "./imageRef.js";
import { updateIdentityPolicy } from "./k8s.js";

/** What a task that isn't a registered product runs as, with no Secrets. */
export const UNREGISTERED_SERVICE_ACCOUNT = "default";

export interface PolicyProduct {
  team: string;
  repository: string;
  action: string;
  serviceAccount: string;
}

export function policyProducts(identities: ProductIdentity[]): PolicyProduct[] {
  return identities.map((identity) => ({
    team: identity.teamName ?? "",
    repository: imageRepository(identity.image),
    action: identity.action,
    serviceAccount: identity.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT,
  }));
}

export function policyTeamSecrets(secrets: { teamName: string; secretName: string }[]): Record<string, string> {
  const byTeam = new Map<string, string[]>();
  for (const { teamName, secretName } of secrets) byTeam.set(teamName, [...(byTeam.get(teamName) ?? []), secretName]);
  return Object.fromEntries([...byTeam].sort().map(([team, names]) => [team, names.sort().join(",")]));
}

/**
 * Writes every registered product and every team's secret names into the
 * identity policy. Errors propagate: a caller that just changed a product
 * or a secret fails (and can retry the idempotent change), rather than
 * leave the cluster enforcing an older list unnoticed. Returns false when
 * there's nothing to write to: no policy configured (tests, local
 * development) or installed.
 */
export async function syncIdentityPolicy(): Promise<boolean> {
  if (!config.identityPolicyName) return false;
  return updateIdentityPolicy(config.identityPolicyName, async () => ({
    products: JSON.stringify(policyProducts(await listProductIdentities())),
    teamSecrets: JSON.stringify(policyTeamSecrets(await listTeamSecretNames())),
  }));
}
