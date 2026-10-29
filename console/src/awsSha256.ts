// SPDX-License-Identifier: MIT
/**
 * SHA-256 as AWS's SigV4 signer (@smithy/signature-v4) takes it, from
 * node:crypto: the Bedrock chat's requests (chat/bedrock.ts) and RDS's
 * sign-in tokens (db/rds.ts).
 */
import { createHash, createHmac, type Hash } from "node:crypto";

type Hmac = ReturnType<typeof createHmac>;

/** SigV4's hash: SHA-256, or HMAC-SHA-256 with a secret. */
export class Sha256 {
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
