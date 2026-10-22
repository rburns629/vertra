// SPDX-License-Identifier: MIT
/**
 * Reading a registry on another cloud with no stored key (M2): a catalog
 * published to Google Artifact Registry, read by an install on EKS (or any
 * cluster). The console's own ServiceAccount token, projected with the
 * Workload Identity provider as its audience, is exchanged at Google's STS
 * for a short-lived access token (Workload Identity Federation), used
 * directly or to impersonate a service account. Nothing is stored that
 * outlives the hour the token lasts.
 *
 * The console federates once, for everything that reads the registry:
 * image checks (registry.ts), and, written as Docker config Secrets every
 * policy sync (pullSecret.ts), the verify and scan Jobs (REGISTRY_TOKEN_SECRET
 * in this namespace) and the kubelet pulling steps' images (vertra-pull in
 * each team namespace). A token is replaced 15 minutes before it expires
 * and the sync runs every few minutes, so those Secrets always hold one
 * that's still good.
 */
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

const STS_URL = "https://sts.googleapis.com/v1/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_BEFORE_MS = 15 * 60_000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const seconds = (value: unknown): number => (typeof value === "number" ? value : 3600);

let cached: { value: string; expiresAt: number } | null = null;

/** Whether federation is configured, and covers `host`. */
export function federatedHost(host: string): boolean {
  return config.registryFederation.gcpProvider !== "" && config.registryFederation.hosts.includes(host);
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    // Google's error bodies say what's wrong (an audience, a binding) and
    // hold no secret; the request's token is never echoed back.
    throw new Error(`${new URL(url).host} answered ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** A Google access token for the federated identity, cached until 15 minutes before it expires. */
export async function federatedGcpToken(): Promise<string> {
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > Date.now()) return cached.value;
  const { gcpProvider, gcpServiceAccount, tokenFile } = config.registryFederation;
  const subjectToken = (await readFile(tokenFile, "utf8")).trim();
  const exchanged = await postJson(STS_URL, {
    grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: `//iam.googleapis.com/${gcpProvider}`,
    scope: SCOPE,
    requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
    subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    subjectToken,
  });
  const federated = text(exchanged["access_token"]);
  if (!federated) throw new Error("Google's STS returned no access token");
  if (!gcpServiceAccount) {
    cached = { value: federated, expiresAt: Date.now() + seconds(exchanged["expires_in"]) * 1000 };
    return federated;
  }
  const impersonated = await postJson(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(gcpServiceAccount)}:generateAccessToken`,
    { scope: [SCOPE], lifetime: "3600s" },
    { authorization: `Bearer ${federated}` },
  );
  const value = text(impersonated["accessToken"]);
  if (!value) throw new Error("IAM Credentials returned no access token");
  const expireTime = Date.parse(text(impersonated["expireTime"]));
  cached = { value, expiresAt: Number.isNaN(expireTime) ? Date.now() + 3_600_000 : expireTime };
  return value;
}

/**
 * The Docker config every reader of the registries gets: the federated
 * hosts with a fresh token, and any static credentials from the pull
 * Secret (registryCheck.pullSecretName) beside them.
 */
export async function federatedDockerConfig(): Promise<string> {
  const auths: Record<string, { auth: string }> = {};
  for (const [host, credential] of config.registryCredentials) {
    auths[host] = { auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64") };
  }
  const token = await federatedGcpToken();
  for (const host of config.registryFederation.hosts) {
    auths[host] = { auth: Buffer.from(`oauth2accesstoken:${token}`).toString("base64") };
  }
  return JSON.stringify({ auths });
}

/** For tests: forget the cached token. */
export function resetFederatedToken(): void {
  cached = null;
}
