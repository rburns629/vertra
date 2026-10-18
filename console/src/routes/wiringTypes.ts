// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { listWiringTypes, replaceWiringTypes } from "../db/queries.js";

/**
 * The catalog's wiring vocabulary (db/schema.ts's wiringTypes), sent as
 * its schema/types.yaml converted to JSON: one entry per type name.
 */
const WiringTypesBody = Type.Record(
  Type.String(),
  Type.Object({
    jsonType: Type.Union([
      Type.Literal("string"),
      Type.Literal("integer"),
      Type.Literal("number"),
      Type.Literal("boolean"),
    ]),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    shared: Type.Boolean(),
    // <team>/<product>.<action>
    defaultProvider: Type.Optional(Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+\\.[a-z0-9-]+$" })),
  }),
  {
    // propertyNames, not a pattern on the key: Fastify drops a property a
    // schema doesn't allow instead of refusing the request, so a misnamed
    // type would vanish silently (and an all-misnamed body would wipe the
    // set). At least one type: the catalog always has some.
    propertyNames: { pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$" },
    minProperties: 1,
    maxProperties: 500,
  },
);

const wiringTypesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/wiring-types", { preHandler: app.authenticate }, async () => listWiringTypes());

  // Who may change it is who may register products: catalog CI's
  // automation token (products:register), or an admin.
  app.put(
    "/wiring-types",
    { schema: { body: WiringTypesBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      if (!authUser?.isAdmin && !hasScope(authUser, SCOPES.PRODUCTS_REGISTER)) {
        reply.code(403).send({
          error: "FORBIDDEN",
          message: "Replacing the wiring types requires admin access or the products:register scope.",
        });
        return;
      }
      const types = Object.entries(request.body).map(([name, type]) => ({
        name,
        jsonType: type.jsonType,
        description: type.description,
        shared: type.shared,
        defaultProvider: type.defaultProvider ?? null,
      }));
      reply.send(await replaceWiringTypes(types));
    },
  );
};

export default wiringTypesRoutes;
