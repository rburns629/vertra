// SPDX-License-Identifier: MIT
/** ImageService (proto/vertra/console/v1/image.proto): core/images.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { AcceptReason, acceptScan, Digest, imagePolicy, listScans, rescan, setImagePolicy } from "../../core/images.js";
import { ScanStatus, type ImageService } from "../../gen/vertra/console/v1/image_pb.js";
import type { ScanFindings, ScanRow } from "../../scanning.js";
import { timestamp } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

const STATUS: Record<string, ScanStatus> = {
  pending: ScanStatus.PENDING,
  passed: ScanStatus.PASSED,
  failed: ScanStatus.FAILED,
  error: ScanStatus.ERROR,
};

function scan(row: ScanRow) {
  const findings = row.findings as ScanFindings | null;
  return {
    digest: row.digest,
    image: row.image,
    status: STATUS[row.status] ?? ScanStatus.UNSPECIFIED,
    findings: findings ?? undefined,
    requestedAt: timestamp(row.requestedAt),
    // The epoch is a rescan's "due now" (core/images.ts), not a time it was scanned.
    scannedAt: row.scannedAt?.getTime() === 0 ? undefined : timestamp(row.scannedAt),
    lastUsedAt: timestamp(row.lastUsedAt),
    acceptedBy: row.acceptedBy ?? undefined,
    acceptedReason: row.acceptedReason ?? undefined,
    acceptedAt: timestamp(row.acceptedAt),
  };
}

export function imageService(): ServiceImpl<typeof ImageService> {
  return {
    async getImagePolicy() {
      return { policy: await imagePolicy() };
    },

    async setImagePolicy(req, ctx) {
      const input = check(
        { source: Type.String(), additional: Type.Array(Type.String()), version: Type.String() },
        req,
      );
      return { policy: await setImagePolicy(callerOf(ctx), input, logOf(ctx)) };
    },

    async listImageScans(_req, ctx) {
      return { scans: (await listScans(callerOf(ctx))).map(scan) };
    },

    async acceptImageScan(req, ctx) {
      const { digest, reason } = check({ digest: Digest, reason: AcceptReason }, req);
      return { scan: scan(await acceptScan(callerOf(ctx), digest, reason, logOf(ctx))) };
    },

    async rescanImage(req, ctx) {
      const { digest } = check({ digest: Digest }, req);
      const row = await rescan(callerOf(ctx), digest);
      return row ? { scan: scan(row) } : {};
    },
  };
}
