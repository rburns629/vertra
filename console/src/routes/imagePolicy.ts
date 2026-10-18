// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  allowedPrefixes,
  invalidSourceReason,
  isBroadSource,
  normalizeSource,
  readImagePolicy,
  writeImagePolicy,
} from "../imagePolicy.js";
import { ImagePolicyConflictError } from "../k8s.js";

/**
 * The allowed image sources (see imagePolicy.ts): readable by anyone signed
 * in, so the submit page can say what's allowed; editable by admins only,
 * since it's the list the cluster enforces for every team.
 */
const imagePolicyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/image-policy", { preHandler: app.authenticate }, async (_request, reply) => {
    const policy = await readImagePolicy();
    reply.send({ ...policy, allowed: allowedPrefixes(policy) });
  });

  app.put(
    "/image-policy",
    {
      schema: {
        body: Type.Object({
          source: Type.String(),
          additional: Type.Array(Type.String()),
          version: Type.String(),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Only admins can change the allowed image sources." });
        return;
      }
      const { source, additional, version } = request.body;
      const entries = [
        { label: "Source registry", value: source },
        ...additional.map((value, i) => ({ label: `Additional source ${String(i + 1)}`, value })),
      ];
      for (const { label, value } of entries) {
        const reason = invalidSourceReason(value);
        if (reason) {
          reply.code(400).send({ error: "BAD_REQUEST", message: `${label} "${value}" ${reason}.` });
          return;
        }
      }

      const before = await readImagePolicy();
      if (!before.exists) {
        reply.code(409).send({
          error: "IMAGE_POLICY_MISSING",
          message: "The cluster's image policy doesn't exist. Installing or upgrading the execution-kernel release creates it.",
        });
        return;
      }
      const cleanAdditional = [...new Set(additional.map(normalizeSource))];
      let newVersion: string;
      try {
        newVersion = await writeImagePolicy(source, cleanAdditional, version);
      } catch (error) {
        if (error instanceof ImagePolicyConflictError) {
          reply.code(409).send({
            error: "CONFLICT",
            message: "The image sources were changed by someone else since you loaded them. Reload and try again.",
          });
          return;
        }
        throw error;
      }
      const after = { source: normalizeSource(source), additional: cleanAdditional };
      request.log.warn(
        {
          event: "image_policy_changed",
          by: request.authUser.id,
          before: { source: before.source, additional: before.additional },
          after,
          broadSources: [after.source, ...after.additional].filter(isBroadSource),
        },
        "allowed image sources changed",
      );
      reply.send({ ...after, exists: true, version: newVersion, allowed: allowedPrefixes({ ...after, exists: true, version: newVersion }) });
    },
  );
};

export default imagePolicyRoutes;
