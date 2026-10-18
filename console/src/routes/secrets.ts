// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import {
  NamespaceNotFoundError,
  SECRET_STORE_CREDENTIAL,
  TEAM_PULL_SECRET,
  SecretNotManagedError,
  deleteSecretGrant,
  listAllSecretStores,
  listExternalSecrets,
  listSecretStores,
  upsertExternalSecretGrant,
  upsertSecretGrant,
} from "../k8s.js";
import {
  deleteSecretGrantRecord,
  findTeamByName,
  isSecretRegistered,
  listSecretGrantsForTeam,
  recordSecretGrant,
} from "../db/queries.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { replyIfRetired } from "./retiredTeam.js";
import { replyIfNotTeamMember } from "../auth/access.js";

// A Kubernetes Secret name (a DNS-1123 subdomain), no longer than a
// Secret volume name may be.
const DNS_SUBDOMAIN = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$";
const SecretName = Type.String({ minLength: 1, maxLength: 120, pattern: DNS_SUBDOMAIN });

const SecretGrantBody = Type.Object({
  namespace: Type.String({ minLength: 1 }),
  secretName: SecretName,
  data: Type.Record(Type.String(), Type.String(), { minProperties: 1 }),
});

const ExternalSecretGrantBody = Type.Object({
  namespace: Type.String({ minLength: 1 }),
  secretName: SecretName,
  secretStoreName: Type.String({ minLength: 1 }),
  keys: Type.Array(
    Type.Object({
      secretKey: Type.String({ minLength: 1 }),
      remoteKey: Type.String({ minLength: 1 }),
      property: Type.Optional(Type.String({ minLength: 1 })),
    }),
    { minItems: 1 },
  ),
});

/** A SecretStore's own credential, or the platform's pull Secret, is never
 * a team secret: it would let a step read what the store signs in with, or
 * the registry credential. Sends the 422 itself. */
function replyIfReservedName(secretName: string, reply: FastifyReply): boolean {
  const reserved: Record<string, string> = {
    [SECRET_STORE_CREDENTIAL]: "a SecretStore's own credential",
    [TEAM_PULL_SECRET]: "the platform's registry pull Secret",
  };
  const purpose = reserved[secretName];
  if (purpose === undefined) return false;
  reply.code(422).send({
    error: "UNPROCESSABLE_ENTITY",
    message: `"${secretName}" is reserved for ${purpose}; choose another name.`,
  });
  return true;
}

/**
 * Writes a secret to the cluster and records it, in the order that never
 * strands one: a secret new to the team is recorded first (the console's
 * records are what make an existing Secret its own to replace, since it
 * never reads Secrets), and the record is removed again if the cluster
 * refuses or fails; a registered one is rewritten, then its record updated.
 * Sends a refusal's 4xx itself and returns false.
 */
async function writeAndRecordOrReply(
  teamId: string,
  secretName: string,
  alreadyGranted: boolean,
  write: () => Promise<void>,
  record: () => Promise<unknown>,
  reply: FastifyReply,
): Promise<boolean> {
  if (!alreadyGranted) await record();
  try {
    await write();
  } catch (error) {
    if (!alreadyGranted) await deleteSecretGrantRecord(teamId, secretName);
    if (replyIfProvisioningRefused(error, reply)) return false;
    throw error;
  }
  if (alreadyGranted) await record();
  return true;
}

/** The team a secret is registered for, or a 404 sent. */
async function teamOrReply(name: string, reply: FastifyReply) {
  const team = await findTeamByName(name);
  if (!team) reply.code(404).send({ error: "NOT_FOUND", message: `No team named "${name}".` });
  return team;
}

async function isAlreadyGranted(teamId: string | undefined, secretName: string): Promise<boolean> {
  return teamId !== undefined && (await isSecretRegistered(teamId, secretName));
}

/** A caller mistake from k8s.ts: sends the 4xx itself and returns true. */
function replyIfProvisioningRefused(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof NamespaceNotFoundError) {
    reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: error.message });
    return true;
  }
  if (error instanceof SecretNotManagedError) {
    reply.code(409).send({ error: "CONFLICT", message: error.message });
    return true;
  }
  return false;
}

/**
 * Register (or rotate) a team's secret. Any of the team's registered
 * products may then mount it, when a task lists it in secretRefs; nothing
 * else may (routes/executions.ts, and the identity policy in the cluster).
 * Requires the caller to be a member of the team that
 * owns the target namespace — team.name and namespace are the same value
 * by convention (see db/schema.ts), so this is a direct membership check,
 * not a separate mapping that could drift from the RBAC it's gating —
 * or a platform admin (see routes/teams.ts for the same pattern applied
 * to team membership).
 */
const secretsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/secrets",
    { schema: { body: SecretGrantBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.body.namespace, reply)) return;
      if (replyIfReservedName(request.body.secretName, reply)) return;
      // Before touching Kubernetes: a retired team gets nothing new.
      // (namespace === team name by convention, see db/schema.ts.)
      const team = await teamOrReply(request.body.namespace, reply);
      if (!team || replyIfRetired(team, reply)) return;
      const alreadyGranted = await isAlreadyGranted(team.id, request.body.secretName);
      const written = await writeAndRecordOrReply(
        team.id,
        request.body.secretName,
        alreadyGranted,
        () => upsertSecretGrant({ ...request.body, alreadyGranted }),
        () =>
          recordSecretGrant({
            teamId: team.id,
            secretName: request.body.secretName,
            keys: Object.keys(request.body.data),
            source: "literal",
          }),
        reply,
      );
      if (!written) return;
      await syncIdentityPolicy();

      reply.code(204).send();
    },
  );

  /**
   * Syncing from a vault (docs/security-model.md): register a
   * Secret whose value is synced from an already-approved external store
   * (a `SecretStore` this route never creates -- see k8s.ts) instead of
   * pasted directly. Same authorization, and the same result for tasks, as
   * POST /secrets above; the only difference is what k8s.ts writes
   * (an ExternalSecret reference vs. a literal Secret).
   */
  app.post(
    "/secrets/external",
    { schema: { body: ExternalSecretGrantBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.body.namespace, reply)) return;
      if (replyIfReservedName(request.body.secretName, reply)) return;
      const team = await teamOrReply(request.body.namespace, reply);
      if (!team || replyIfRetired(team, reply)) return;
      const alreadyGranted = await isAlreadyGranted(team.id, request.body.secretName);
      const written = await writeAndRecordOrReply(
        team.id,
        request.body.secretName,
        alreadyGranted,
        () => upsertExternalSecretGrant({ ...request.body, alreadyGranted }),
        () =>
          recordSecretGrant({
            teamId: team.id,
            secretName: request.body.secretName,
            keys: request.body.keys.map((k) => k.secretKey),
            source: "external",
          }),
        reply,
      );
      if (!written) return;
      await syncIdentityPolicy();

      reply.code(204).send();
    },
  );

  /**
   * Revoke a secret: its registration, and the Secret (or ExternalSecret)
   * the console created for it. Tasks
   * already running keep what they mounted; new ones can't name it.
   */
  app.delete(
    "/teams/:teamName/secrets/:secretName",
    {
      schema: { params: Type.Object({ teamName: Type.String(), secretName: Type.String() }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { teamName, secretName } = request.params;
      if (replyIfNotTeamMember(request.authUser, teamName, reply)) return;
      const team = await findTeamByName(teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (replyIfRetired(team, reply)) return;
      const grant = (await listSecretGrantsForTeam(team.id)).find((g) => g.secretName === secretName);
      if (!grant) {
        reply.code(404).send({ error: "NOT_FOUND", message: `No secret "${secretName}" is registered for this team.` });
        return;
      }
      // The cluster first: if that fails, the grant stays on record and the
      // revoke can simply be tried again.
      await deleteSecretGrant(teamName, secretName, grant.source);
      await deleteSecretGrantRecord(team.id, secretName);
      await syncIdentityPolicy();
      request.log.info({ team: teamName, secret: secretName, by: request.authUser?.id }, "secret revoked");
      reply.code(204).send();
    },
  );

  app.get(
    "/teams/:teamName/secrets",
    {
      schema: { params: Type.Object({ teamName: Type.String() }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      const grants = await listSecretGrantsForTeam(team.id);
      // Live per request: whether a sync works right now is the point.
      // One list call covers every ExternalSecret, including ones created
      // outside the console (kubectl, a GitOps tool), which are listed too
      // so the table is the whole truth about what this team's tasks can
      // be given. Those aren't registered, so no task can mount them until
      // someone registers them here.
      const externals = await listExternalSecrets(request.params.teamName);
      const byName = new Map(externals.map((e) => [e.name, e]));
      const granted = new Set(grants.map((g) => g.secretName));
      reply.send([
        ...grants.map((grant) => ({
          id: grant.id,
          secretName: grant.secretName,
          keys: grant.keys,
          source: grant.source,
          managed: true,
          updatedAt: grant.updatedAt,
          external: grant.source === "external" ? (byName.get(grant.secretName) ?? null) : null,
        })),
        ...externals
          .filter((e) => !granted.has(e.name))
          .map((e) => ({
            id: `external:${e.name}`,
            secretName: e.name,
            keys: e.entries.map((entry) => entry.secretKey),
            source: "external",
            managed: false,
            updatedAt: e.lastSyncedAt,
            external: e,
          })),
      ]);
    },
  );

  /** The team's secret sources: each SecretStore in its namespace, where it
   * connects, who it signs in as, and whether that works right now. A store
   * whose identity another team's store also uses is flagged, since either
   * team could then sync whatever the other can; only an admin is told
   * which teams. */
  app.get(
    "/teams/:teamName/secret-stores",
    {
      schema: { params: Type.Object({ teamName: Type.String() }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { teamName } = request.params;
      if (replyIfNotTeamMember(request.authUser, teamName, reply)) return;
      const stores = await listSecretStores(teamName);
      const everywhere = stores.some((s) => s.identity) ? await listAllSecretStores() : [];
      const isAdmin = request.authUser?.isAdmin ?? false;
      reply.send(
        stores.map((store) => {
          const sharedWith = store.identity
            ? [
                ...new Set(
                  everywhere
                    .filter((o) => o.namespace !== teamName && o.store.identity === store.identity)
                    .map((o) => o.namespace),
                ),
              ]
            : [];
          return {
            ...store,
            sharedWithCount: sharedWith.length,
            sharedWith: isAdmin ? sharedWith : null,
          };
        }),
      );
    },
  );
};

export default secretsRoutes;
