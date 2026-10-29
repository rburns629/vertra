// SPDX-License-Identifier: MIT
/**
 * Claude in Amazon Bedrock speaks Anthropic's Messages API at
 * https://bedrock-mantle.<region>.api.aws/anthropic, signed with AWS SigV4
 * (service bedrock-mantle) instead of a key. This signs each request the
 * Anthropic client makes, as the console's own AWS identity: the default
 * credential chain, which on EKS is Pod Identity (the role vertra's module
 * grants bedrock-mantle:CreateInference on the one model). Nothing stored.
 *
 * Anthropic's @anthropic-ai/bedrock-sdk does the same; it isn't used
 * because its release for the client the console runs is days old. AWS's
 * own signer and credential chain are already the console's (ECR, S3).
 */
import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

/** SigV4's hash: SHA-256, or HMAC-SHA-256 with a secret. */
class Sha256 {
  private hash: Hash | Hmac;

  constructor(private readonly secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash = this.fresh();
  }

  private fresh(): Hash | Hmac {
    if (this.secret === undefined) return createHash("sha256");
    const key = typeof this.secret === "string" ? this.secret : Buffer.from(this.secret as ArrayBuffer);
    return createHmac("sha256", key);
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }

  reset(): void {
    this.hash = this.fresh();
  }
}

/** Headers the SDK sends that aren't Bedrock's: its placeholder key, and ones a proxy may change. */
const UNSIGNED = new Set(["x-api-key", "authorization", "connection", "content-length"]);

/**
 * A fetch for the Anthropic client that signs every request for Bedrock in
 * `region`, as whoever the AWS credential chain finds.
 */
export function bedrockFetch(region: string, fetchFn: typeof fetch = fetch, credentials = defaultProvider()): typeof fetch {
  const signer = new SignatureV4({ service: "bedrock-mantle", region, credentials, sha256: Sha256 });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      if (!UNSIGNED.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    });
    headers["host"] = url.host;
    const body = typeof init?.body === "string" ? init.body : init?.body === undefined || init.body === null ? undefined : await new Response(init.body).text();
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
    });
    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    return fetchFn(url, { ...init, headers: signed.headers, ...(body !== undefined ? { body } : {}) });
  };
}
