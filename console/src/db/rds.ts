// SPDX-License-Identifier: MIT
/**
 * Amazon RDS's IAM database authentication: the password is a token the
 * console's own role (EKS Pod Identity, found by AWS's credential chain)
 * signs locally for one user at one server, good for 15 minutes to open a
 * connection. Kept ten.
 */
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "../awsSha256.js";

const KEPT_MS = 10 * 60 * 1000;

/** A token source for one server and user, in region. */
export function rdsTokens(
  region: string,
  host: string,
  port: number,
  user: string,
  credentials: ReturnType<typeof defaultProvider> = defaultProvider(),
  now: () => number = Date.now,
): () => Promise<string> {
  const signer = new SignatureV4({ service: "rds-db", region, credentials, sha256: Sha256 });
  let kept: { token: string; until: number } | null = null;
  return async () => {
    if (kept && now() < kept.until) return kept.token;
    const signed = await signer.presign(
      { method: "GET", protocol: "https:", hostname: host, port, path: "/", query: { Action: "connect", DBUser: user }, headers: { host: `${host}:${String(port)}` } },
      { expiresIn: 900 },
    );
    const query = Object.entries(signed.query ?? {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    kept = { token: `${host}:${String(port)}/?${query}`, until: now() + KEPT_MS };
    return kept.token;
  };
}
