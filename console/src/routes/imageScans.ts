// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { imageScans } from "../db/schema.js";
import { requestScan, syncScanPolicy } from "../scanning.js";

const Digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

/**
 * Image scan verdicts (scanning.ts), for admins: the list, accepting a
 * failed one (with a reason, the platform's counterpart of a product's
 * .trivyignore), and asking for a rescan. Accepting lets the image be
 * registered and run again; it's cleared by a rescan that finds something
 * the admin didn't see.
 */
const imageScansRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/image-scans", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
      return;
    }
    reply.send(await db.select().from(imageScans).orderBy(desc(imageScans.lastUsedAt)).limit(500));
  });

  app.post(
    "/image-scans/:digest/accept",
    {
      schema: {
        params: Type.Object({ digest: Digest }),
        body: Type.Object({ reason: Type.String({ minLength: 10, maxLength: 2000 }) }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      if (!authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
        return;
      }
      const [row] = await db
        .update(imageScans)
        .set({ acceptedAt: new Date(), acceptedBy: authUser.id, acceptedReason: request.body.reason })
        .where(eq(imageScans.digest, request.params.digest))
        .returning();
      if (!row) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No scan for that digest." });
        return;
      }
      await syncScanPolicy();
      request.log.info(
        {
          event: "image_scan_accepted",
          digest: row.digest,
          image: row.image,
          by: authUser.id,
          reason: request.body.reason,
        },
        "image scan verdict accepted",
      );
      reply.send(row);
    },
  );

  app.post(
    "/image-scans/:digest/rescan",
    { schema: { params: Type.Object({ digest: Digest }) }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
        return;
      }
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, request.params.digest));
      if (!row) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No scan for that digest." });
        return;
      }
      // Due now: requestScan starts it.
      await db.update(imageScans).set({ scannedAt: new Date(0) }).where(eq(imageScans.digest, row.digest));
      reply.code(202).send(await requestScan(`${row.image.split("@")[0] ?? row.image}@${row.digest}`));
    },
  );
};

export default imageScansRoutes;
