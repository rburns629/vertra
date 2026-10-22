// SPDX-License-Identifier: MIT
/** ObserveService (proto/vertra/console/v1/observe.proto): core/observe.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { getMetrics, getSecurity } from "../../core/observe.js";
import type { ObserveService } from "../../gen/vertra/console/v1/observe_pb.js";
import { timestamp } from "../convert.js";
import { callerOf } from "../context.js";
import { viaKernel } from "./execution.js";

export function observeService(): ServiceImpl<typeof ObserveService> {
  return {
    async getSecurity(_req, ctx) {
      const s = await viaKernel(ctx, () => getSecurity(callerOf(ctx)));
      return {
        checks: s.checks,
        refusals: s.refusals.map((r) => ({ ...r, at: timestamp(r.at) })),
        images: s.images.map((i) => ({ ...i, scannedAt: timestamp(i.scannedAt) })),
      };
    },

    async getMetrics(_req, ctx) {
      const m = await viaKernel(ctx, () => getMetrics(callerOf(ctx)));
      return { ...m, hours: m.hours.map((h) => ({ ...h, hour: timestamp(h.hour) })) };
    },
  };
}
