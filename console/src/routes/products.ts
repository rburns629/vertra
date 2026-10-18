// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  deleteProductByName,
  findProductByName,
  findTeamById,
  findTeamByIdIncludingDeleted,
  findTeamByName,
  listImageRepositories,
  listProducts,
  ProductOwnershipError,
  releaseImageRepository,
  upsertProduct,
} from "../db/queries.js";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { replyIfRetired } from "./retiredTeam.js";
import { canActForTeam } from "../auth/access.js";
import { ensureServiceAccount, NamespaceNotFoundError } from "../k8s.js";
import { config } from "../config.js";
import { pinImages } from "../registry.js";
import { allowedPrefixes, readImagePolicy } from "../imagePolicy.js";
import { digestOf, requestScan } from "../scanning.js";

/** A ServiceAccount or Secret name: a Kubernetes DNS-1123 subdomain. */
const KubernetesName = Type.String({ pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", maxLength: 253 });

/** A Kubernetes quantity, the same rule as the kernel's TaskResources ("250m", "512Mi"). */
const Quantity = Type.String({ pattern: "^[0-9]+(\\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$", maxLength: 32 });

/** The Pod size the product's tasks get unless a task sets its own. */
const Resources = Type.Object(
  {
    cpu: Type.Optional(Quantity),
    memory: Type.Optional(Quantity),
    memoryLimit: Type.Optional(Quantity),
  },
  { additionalProperties: false },
);

const RegisterProductBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  image: Type.String({ minLength: 1 }),
  action: Type.String({ minLength: 1 }),
  // Absent or null: a platform product -- admin-only
  // to register, since no team is vouching for it. Present: that team's
  // product -- registering it requires membership in that team (or admin),
  // same as everything else team-scoped.
  team: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // The rest of the action's product.yaml (see db/schema.ts). Each one
  // left out keeps what's already stored.
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  serviceAccount: Type.Optional(KubernetesName),
  requiredSecrets: Type.Optional(Type.Array(KubernetesName, { uniqueItems: true, maxItems: 50 })),
  resources: Type.Optional(Resources),
});

/** A Postgres unique_violation -- see db/queries.ts's upsertProduct:
 * registering the same (image, action) pair under a second name hits the
 * other unique constraint, which isn't the "already registered, update it"
 * case onConflictDoUpdate handles (that's keyed on name). drizzle-orm
 * wraps the pg error in DrizzleQueryError, with the one carrying the
 * SQLSTATE as `.cause` (undocumented; seen in the installed version). */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

/** Who owns what a registration collided with, in words. */
async function ownershipMessage(error: ProductOwnershipError, name: string): Promise<string> {
  let owner = "the platform (no team)";
  if (error.ownerTeamId !== null) {
    const team = await findTeamByIdIncludingDeleted(error.ownerTeamId);
    owner = team ? `team "${team.name}"${team.deletedAt ? " (purged)" : ""}` : "another team";
  }
  return error.conflict === "name"
    ? `The product name "${name}" belongs to ${owner}.`
    : `This image's repository belongs to ${owner}: only its products may use it. An admin can release a repository no product uses.`;
}

/**
 * The product registry: what a DAG step can reference (see db/schema.ts).
 * Registration is meant to be called by catalog CI as the last step of a
 * successful build (authenticated as an automation token holding
 * `products:register`, see auth/scopes.ts), not by
 * a human clicking a button after the fact -- the real approval already
 * happened at PR-merge time via CODEOWNERS. Deletion is the same: catalog
 * CI calls this after deleting the image from Artifactory itself (this
 * service never holds registry-delete credentials on any team's behalf).
 */
const productsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/products", { preHandler: app.authenticate }, async (_request, reply) => {
    // Read access isn't scoped like write access is -- discovering what
    // products exist (to build a DAG from) is a different concern than
    // who's allowed to vouch for one, same distinction already settled
    // for the catalog itself.
    reply.send(await listProducts());
  });

  app.post(
    "/products",
    { schema: { body: RegisterProductBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      const teamName = request.body.team ?? null;

      let teamId: string | null = null;
      if (teamName === null) {
        if (!authUser?.isAdmin) {
          reply.code(403).send({
            error: "FORBIDDEN",
            message: "Registering a platform product (no team) requires admin access.",
          });
          return;
        }
      } else {
        if (!canActForTeam(authUser, teamName) && !hasScope(authUser, SCOPES.PRODUCTS_REGISTER)) {
          reply.code(403).send({
            error: "FORBIDDEN",
            message: `Not a member of team "${teamName}", and not a platform admin.`,
          });
          return;
        }
        const team = await findTeamByName(teamName);
        if (!team) {
          reply.code(404).send({ error: "NOT_FOUND", message: `No such team: "${teamName}".` });
          return;
        }
        if (replyIfRetired(team, reply)) return;
        teamId = team.id;
        // Its ServiceAccount exists from registration on, so the platform
        // team can bind a cloud identity to it before its first run. Created
        // if missing, never modified (k8s.ts). A platform product's is
        // created in each team namespace it first runs in.
        const serviceAccount = request.body.serviceAccount;
        if (serviceAccount && serviceAccount !== "default") {
          try {
            await ensureServiceAccount(teamName, serviceAccount);
          } catch (error) {
            if (!(error instanceof NamespaceNotFoundError)) throw error;
            reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: error.message });
            return;
          }
        }
      }

      // Its image is scanned from registration on (scanning.ts): pinned
      // already (catalog CI registers by digest), or resolved here. A digest
      // whose scan failed isn't registered; one still being scanned is, and
      // submissions wait for its verdict.
      if (config.scanning.enabled) {
        let pinned: string | undefined = digestOf(request.body.image) ? request.body.image : undefined;
        if (!pinned) {
          const policy = await readImagePolicy();
          pinned = (await pinImages([request.body.image], allowedPrefixes(policy))).pinned.get(request.body.image);
        }
        const scan = pinned ? await requestScan(pinned) : null;
        if (scan?.status === "failed" && scan.acceptedAt === null) {
          reply.code(422).send({
            error: "IMAGE_SCAN_FAILED",
            message: `${pinned ?? request.body.image} fails the security scan; it isn't registered. Rebuild it, or an admin can accept it with a reason.`,
            findings: scan.findings,
          });
          return;
        }
      }

      try {
        const {
          name,
          image,
          action,
          inputSchema,
          displayName,
          description,
          outputSchema,
          serviceAccount,
          requiredSecrets,
          resources,
        } = request.body;
        const product = await upsertProduct({
          name,
          image,
          action,
          teamId,
          inputSchema,
          displayName,
          description,
          outputSchema,
          serviceAccount,
          requiredSecrets,
          resources,
        });
        await syncIdentityPolicy();
        reply.code(200).send(product);
      } catch (error) {
        if (error instanceof ProductOwnershipError) {
          reply.code(409).send({ error: "CONFLICT", message: await ownershipMessage(error, request.body.name) });
          return;
        }
        if (isUniqueViolation(error)) {
          reply.code(409).send({
            error: "CONFLICT",
            message: `"${request.body.image}" + "${request.body.action}" is already registered under a different name.`,
          });
          return;
        }
        throw error;
      }
    },
  );

  app.delete(
    "/products/:name",
    { schema: { params: Type.Object({ name: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const product = await findProductByName(request.params.name);
      if (!product) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such product." });
        return;
      }
      const authUser = request.authUser;
      if (product.teamId === null) {
        if (!authUser?.isAdmin) {
          reply.code(403).send({
            error: "FORBIDDEN",
            message: "Deleting a platform product (no team) requires admin access.",
          });
          return;
        }
      } else {
        const team = await findTeamById(product.teamId);
        const canAct = team ? canActForTeam(authUser, team.name) : (authUser?.isAdmin ?? false);
        if (!canAct && !hasScope(authUser, SCOPES.PRODUCTS_REGISTER)) {
          reply.code(403).send({
            error: "FORBIDDEN",
            message: "Not a member of the team that owns this product, and not a platform admin.",
          });
          return;
        }
      }
      await deleteProductByName(request.params.name);
      await syncIdentityPolicy();
      reply.code(204).send();
    },
  );

  // Which team owns each image repository (see db/schema.ts's
  // imageRepositories). Admin only: releasing one lets any team claim it.
  app.get("/image-repositories", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
      return;
    }
    reply.send(await listImageRepositories());
  });

  app.delete(
    "/image-repositories",
    {
      // A repository has slashes in it, so it's a query parameter, not a path segment.
      schema: { querystring: Type.Object({ repository: Type.String({ minLength: 1 }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access." });
        return;
      }
      const outcome = await releaseImageRepository(request.query.repository);
      if (outcome === "not-found") {
        reply.code(404).send({ error: "NOT_FOUND", message: "No team owns that repository." });
      } else if (outcome === "in-use") {
        reply.code(409).send({
          error: "CONFLICT",
          message: "Registered products still use that repository: delete them first.",
        });
      } else {
        reply.code(204).send();
      }
    },
  );
};

export default productsRoutes;
