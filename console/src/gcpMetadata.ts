// SPDX-License-Identifier: MIT
/**
 * The console's own Google access token (GKE Workload Identity), from the
 * node's metadata server: the registry's, auditExport.ts's, sso.ts's, the
 * chat's on Vertex, and the database's password with Cloud SQL's IAM
 * database authentication (db/connection.ts). Kept until a minute before
 * it expires. Imports nothing of the console's, so the database layer can
 * use it.
 */
const GCP_METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const REQUEST_TIMEOUT_MS = 5000;

let gcpToken: { value: string; expiresAt: number } | null = null;

export async function gcpMetadataToken(): Promise<string> {
  if (gcpToken && gcpToken.expiresAt > Date.now()) return gcpToken.value;
  // The metadata server is node-local and only speaks plain HTTP.
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
  const response = await fetch(GCP_METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`metadata server returned ${String(response.status)}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  gcpToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return gcpToken.value;
}
