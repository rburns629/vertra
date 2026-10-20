// SPDX-License-Identifier: MIT
/**
 * The product registry, what a DAG step can reference (db/schema.ts), and
 * the catalog's wiring types: the logic behind the REST routes
 * (routes/products.ts, routes/wiringTypes.ts) and ProductService.
 *
 * Registration is catalog CI's last step after a successful build (an
 * automation token holding products:register, auth/scopes.ts), not a
 * person clicking a button: the real approval happened when the pull
 * request merged, through CODEOWNERS. Reading isn't scoped like writing:
 * discovering what exists is a different concern from vouching for it.
 */
import { Type } from "@sinclair/typebox";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import { canActForTeam } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { config } from "../config.js";
import {
  deleteProductByName,
  findProductByName,
  findTeamById,
  findTeamByIdIncludingDeleted,
  findTeamByName,
  listImageRepositories,
  listProducts,
  listWiringTypes,
  ProductOwnershipError,
  releaseImageRepository,
  replaceWiringTypes,
  upsertProduct,
} from "../db/queries.js";
import { allowedPrefixes, readImagePolicy } from "../imagePolicy.js";
import { ensureServiceAccount, NamespaceNotFoundError } from "../k8s.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { pinImages } from "../registry.js";
import { ensureNotRetired } from "./retired.js";
import { digestOf, requestScan } from "../scanning.js";

const REQUIRES_ADMIN = "Requires admin access.";

/** A ServiceAccount or Secret name: a Kubernetes DNS-1123 subdomain. */
export const KubernetesName = Type.String({ pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", maxLength: 253 });

/** A Kubernetes quantity, the same rule as the kernel's TaskResources ("250m", "512Mi"). */
const Quantity = Type.String({ pattern: "^[0-9]+(\\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$", maxLength: 32 });

/** The Pod size the product's tasks get unless a task sets its own. */
export const Resources = Type.Object(
  {
    cpu: Type.Optional(Quantity),
    memory: Type.Optional(Quantity),
    memoryLimit: Type.Optional(Quantity),
  },
  { additionalProperties: false },
);

export const RegisterProductBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  image: Type.String({ minLength: 1 }),
  action: Type.String({ minLength: 1 }),
  // Absent or null: a platform product, admin-only to register, since no
  // team is vouching for it. Present: that team's product, which requires
  // membership in that team (or admin), as everything team-scoped does.
  team: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // The rest of the action's product.yaml (see db/schema.ts). Each one left
  // out keeps what's already stored.
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  serviceAccount: Type.Optional(KubernetesName),
  secretRefs: Type.Optional(Type.Array(KubernetesName, { uniqueItems: true, maxItems: 50 })),
  resources: Type.Optional(Resources),
  // A team name, or "*" for every team.
  shareWith: Type.Optional(
    Type.Array(Type.Union([Type.Literal("*"), Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" })]), {
      uniqueItems: true,
      maxItems: 200,
    }),
  ),
  deprecated: Type.Optional(Type.String({ maxLength: 1000 })),
});

export type RegisterProductInput = {
  name: string;
  image: string;
  action: string;
  team?: string | null;
  inputSchema?: Record<string, unknown>;
  displayName?: string;
  description?: string;
  outputSchema?: Record<string, unknown>;
  serviceAccount?: string;
  secretRefs?: string[];
  resources?: { cpu?: string; memory?: string; memoryLimit?: string };
  shareWith?: string[];
  /** Empty: not deprecated. */
  deprecated?: string;
};

/**
 * The catalog's wiring vocabulary (db/schema.ts's wiringTypes), sent as its
 * schema/types.yaml converted to JSON: one entry per type name.
 */
export const WiringTypesBody = Type.Record(
  // A type's name: lower-case words joined by dots (gcp.project). Any
  // other key is refused, rather than vanishing (an all-misnamed body would
  // otherwise wipe the set).
  Type.String({ pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$" }),
  Type.Object({
    jsonType: Type.Union([Type.Literal("string"), Type.Literal("integer"), Type.Literal("number"), Type.Literal("boolean")]),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    shared: Type.Boolean(),
    // <team>/<product>.<action>
    defaultProvider: Type.Optional(Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+\\.[a-z0-9-]+$" })),
  }),
  {
    additionalProperties: false,
    // At least one type: the catalog always has some.
    minProperties: 1,
    maxProperties: 500,
  },
);

/** A Postgres unique_violation: registering the same (image, action) pair
 * under a second name hits the other unique constraint, which isn't the
 * "already registered, update it" case onConflictDoUpdate handles (keyed on
 * name). drizzle-orm wraps the pg error, the one with the SQLSTATE as its
 * `.cause` (undocumented; seen in the installed version). */
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

/** Every product (anyone signed in). */
export function products() {
  return listProducts();
}

export async function registerProduct(caller: AuthUser | undefined, input: RegisterProductInput) {
  const teamName = input.team ?? null;

  let teamId: string | null = null;
  if (teamName === null) {
    forbiddenUnlessAdmin(caller, "Registering a platform product (no team) requires admin access.");
  } else {
    if (!canActForTeam(caller, teamName) && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
      throw new ApiError(403, "FORBIDDEN", `Not a member of team "${teamName}", and not a platform admin.`);
    }
    const team = await findTeamByName(teamName);
    if (!team) throw new ApiError(404, "NOT_FOUND", `No such team: "${teamName}".`);
    ensureNotRetired(team);
    teamId = team.id;
    // Its ServiceAccount exists from registration on, so the platform team
    // can bind a cloud identity to it before its first run. Created if
    // missing, never modified (k8s.ts). A platform product's is created in
    // each team namespace it first runs in.
    const serviceAccount = input.serviceAccount;
    if (serviceAccount && serviceAccount !== "default") {
      try {
        await ensureServiceAccount(teamName, serviceAccount);
      } catch (error) {
        if (!(error instanceof NamespaceNotFoundError)) throw error;
        throw new ApiError(422, "UNPROCESSABLE_ENTITY", error.message);
      }
    }
  }

  // Its image is scanned from registration on (scanning.ts): pinned already
  // (catalog CI registers by digest), or resolved here. A digest whose scan
  // failed isn't registered; one still being scanned is, and submissions
  // wait for its verdict.
  if (config.scanning.enabled) {
    let pinned: string | undefined = digestOf(input.image) ? input.image : undefined;
    if (!pinned) {
      const policy = await readImagePolicy();
      pinned = (await pinImages([input.image], allowedPrefixes(policy))).pinned.get(input.image);
    }
    const scan = pinned ? await requestScan(pinned) : null;
    if (scan?.status === "failed" && scan.acceptedAt === null) {
      throw new ApiError(
        422,
        "IMAGE_SCAN_FAILED",
        `${pinned ?? input.image} fails the security scan; it isn't registered. Rebuild it, or an admin can accept it with a reason.`,
        undefined,
        { findings: scan.findings },
      );
    }
  }

  try {
    const product = await upsertProduct({
      name: input.name,
      image: input.image,
      action: input.action,
      teamId,
      inputSchema: input.inputSchema,
      displayName: input.displayName,
      description: input.description,
      outputSchema: input.outputSchema,
      serviceAccount: input.serviceAccount,
      secretRefs: input.secretRefs,
      shareWith: input.shareWith,
      deprecated: input.deprecated === undefined ? undefined : input.deprecated || null,
      resources: input.resources,
    });
    await syncIdentityPolicy();
    return product;
  } catch (error) {
    if (error instanceof ProductOwnershipError) {
      throw new ApiError(409, "CONFLICT", await ownershipMessage(error, input.name));
    }
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        "CONFLICT",
        `"${input.image}" + "${input.action}" is already registered under a different name.`,
      );
    }
    throw error;
  }
}

export async function deleteProduct(caller: AuthUser | undefined, name: string): Promise<void> {
  const product = await findProductByName(name);
  if (!product) throw new ApiError(404, "NOT_FOUND", "No such product.");
  if (product.teamId === null) {
    forbiddenUnlessAdmin(caller, "Deleting a platform product (no team) requires admin access.");
  } else {
    const team = await findTeamById(product.teamId);
    const canAct = team ? canActForTeam(caller, team.name) : (caller?.isAdmin ?? false);
    if (!canAct && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Not a member of the team that owns this product, and not a platform admin.",
      );
    }
  }
  await deleteProductByName(name);
  await syncIdentityPolicy();
}

/** Which team owns each image repository (db/schema.ts's imageRepositories). Admins only. */
export async function imageRepositories(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return listImageRepositories();
}

/** Lets any team claim a repository no product uses. Admins only. */
export async function releaseRepository(caller: AuthUser | undefined, repository: string): Promise<void> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const outcome = await releaseImageRepository(repository);
  if (outcome === "not-found") throw new ApiError(404, "NOT_FOUND", "No team owns that repository.");
  if (outcome === "in-use") {
    throw new ApiError(409, "CONFLICT", "Registered products still use that repository: delete them first.");
  }
}

export function wiringTypes() {
  return listWiringTypes();
}

/** Replaces every wiring type: an admin, or whoever may register products (catalog CI). */
export async function setWiringTypes(
  caller: AuthUser | undefined,
  body: Record<string, { jsonType: "string" | "integer" | "number" | "boolean"; description: string; shared: boolean; defaultProvider?: string }>,
) {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Replacing the wiring types requires admin access or the products:register scope.",
    );
  }
  const types = Object.entries(body).map(([name, type]) => ({
    name,
    jsonType: type.jsonType,
    description: type.description,
    shared: type.shared,
    defaultProvider: type.defaultProvider ?? null,
  }));
  return replaceWiringTypes(types);
}
