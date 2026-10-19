// SPDX-License-Identifier: MIT
/**
 * When the console was last used: any answered /api request from a signed-in
 * user or a bot, reads included. Recorded at most once a minute per copy in
 * the chart's activity ConfigMap (k8s.ts recordActivity), which the kernel's
 * sleeper reads to tell an idle platform from one someone is looking at. A
 * failed write is logged and tried again on a later request: it can only
 * make the platform look idler than it is, never touch anything else.
 */
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { recordActivity } from "./k8s.js";

const INTERVAL_MS = 60_000;
let lastRecorded = 0;

export function registerActivity(app: FastifyInstance): void {
  if (!config.activityConfigMap || !config.platformNamespace) return;
  app.addHook("onResponse", async (request) => {
    if (!request.authUser || !request.url.startsWith("/api/")) return;
    const now = Date.now();
    if (now - lastRecorded < INTERVAL_MS) return;
    lastRecorded = now;
    try {
      await recordActivity(config.platformNamespace, config.activityConfigMap, new Date(now));
    } catch (error) {
      lastRecorded = 0;
      request.log.warn({ err: error, event: "activity_write_failed" }, "couldn't record the console's activity");
    }
  });
}
