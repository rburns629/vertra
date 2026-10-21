// SPDX-License-Identifier: MIT
/**
 * What a team's SecretStore file may hold, checked before the console
 * applies it (PUT /teams/:team/secret-store). A SecretStore decides which
 * vault, and which identity in it, a team's namespace can read, so the file
 * must not reach outside its own team. It may only hold:
 *
 *  - SecretStores (external-secrets.io), for this team's namespace (no
 *    ClusterSecretStore), whose references never name another namespace,
 *    and whose stored credential, if any, is the Secret eso-auth;
 *  - the ServiceAccounts ESO signs in as with a cloud identity: eso-gcp,
 *    eso-azure, eso-aws.
 *
 * The same rules as the catalog's own pull-request check (its
 * `./vertra catalog secret-stores check`): that one gives the author an early
 * answer; this one is the one that holds.
 */
import { SECRET_STORE_CREDENTIAL } from "./k8s.js";

export const ESO_SERVICE_ACCOUNTS = ["eso-gcp", "eso-azure", "eso-aws"];
const SECRET_STORE_APIS = ["external-secrets.io/v1", "external-secrets.io/v1beta1"];
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

export interface SecretStoreObject {
  kind: "SecretStore" | "ServiceAccount";
  apiVersion: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every key ending in secretRef (any case), with its value, under `node`. */
function secretRefs(node: unknown, path: string): [string, unknown][] {
  if (Array.isArray(node)) return node.flatMap((value, index) => secretRefs(value, `${path}[${String(index)}]`));
  if (!isRecord(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const child = `${path}.${key}`;
    const here: [string, unknown][] = key.toLowerCase().endsWith("secretref") ? [[child, value]] : [];
    return [...here, ...secretRefs(value, child)];
  });
}

/** Every `namespace` key under `node`: a reference into another namespace. */
function namespaceKeys(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((value, index) => namespaceKeys(value, `${path}[${String(index)}]`));
  if (!isRecord(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const child = `${path}.${key}`;
    return [...(key === "namespace" ? [child] : []), ...namespaceKeys(value, child)];
  });
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** The file's objects when every one is allowed; otherwise every problem. */
export function checkSecretStoreObjects(
  team: string,
  documents: unknown[],
): { objects: SecretStoreObject[]; problems: [] } | { objects: []; problems: string[] } {
  const problems: string[] = [];
  const objects: SecretStoreObject[] = [];
  documents.forEach((doc, index) => {
    let where = `document ${String(index + 1)}`;
    if (!isRecord(doc)) {
      problems.push(`${where}: isn't a Kubernetes object.`);
      return;
    }
    const { kind, apiVersion } = doc;
    const metadata = isRecord(doc["metadata"]) ? doc["metadata"] : {};
    const name = metadata["name"];
    where = `${typeof kind === "string" ? kind : "?"} ${typeof name === "string" ? name : "?"} (${where})`;
    if (typeof name !== "string" || !NAME.test(name)) {
      problems.push(`${where}: metadata.name must be a Kubernetes name.`);
      return;
    }
    const namespace = metadata["namespace"];
    if (namespace !== undefined && namespace !== team) {
      problems.push(`${where}: namespace must be "${team}" (or left out), not ${JSON.stringify(namespace)}.`);
    }
    const annotations = metadata["annotations"];
    if (annotations !== undefined && !stringMap(annotations)) {
      problems.push(`${where}: metadata.annotations must map names to strings.`);
    }
    if (kind === "ServiceAccount" && apiVersion === "v1") {
      if (!ESO_SERVICE_ACCOUNTS.includes(name)) {
        problems.push(
          `${where}: the only ServiceAccounts allowed here are the ones ESO signs in as: ${ESO_SERVICE_ACCOUNTS.join(", ")}.`,
        );
      }
      objects.push({ kind, apiVersion, metadata: { name, ...(stringMap(annotations) ? { annotations } : {}) } });
    } else if (kind === "SecretStore" && typeof apiVersion === "string" && SECRET_STORE_APIS.includes(apiVersion)) {
      const spec = doc["spec"];
      for (const path of namespaceKeys(spec, "spec")) {
        problems.push(`${where}: ${path} points into another namespace; leave it out.`);
      }
      for (const [path, ref] of secretRefs(spec, "spec")) {
        if (!isRecord(ref) || ref["name"] !== SECRET_STORE_CREDENTIAL) {
          problems.push(
            `${where}: ${path} must name the Secret "${SECRET_STORE_CREDENTIAL}" (the team's stored credential), ` +
              `not ${JSON.stringify(isRecord(ref) ? ref["name"] : ref)}.`,
          );
        }
      }
      objects.push({ kind, apiVersion, metadata: { name }, spec });
    } else {
      problems.push(
        `${where}: only SecretStore (${SECRET_STORE_APIS.join(" or ")}) and ServiceAccount (v1) are allowed here.`,
      );
    }
  });
  if (!objects.some((o) => o.kind === "SecretStore")) problems.push("No SecretStore in the file.");
  return problems.length > 0 ? { objects: [], problems } : { objects, problems: [] };
}
