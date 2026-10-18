// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  createTeam,
  deleteProductsForTeam,
  findTeamByName,
  findTeamByNameIncludingDeleted,
  findUserByEmail,
  addTeamMember,
  listAllTeams,
  listMembersForTeam,
  listSubmittedExecutionsForTeams,
  purgeTeam,
  removeTeamMember,
  setTeamRetired,
} from "../db/queries.js";
import { replyIfRetired } from "./retiredTeam.js";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { getExecutionStates } from "../kernel/client.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { copyPullSecret } from "../pullSecret.js";
import { createHash } from "node:crypto";
import { canActForTeam, replyIfNotTeamMember } from "../auth/access.js";
import { config } from "../config.js";
import {
  applySecretStoreObjects,
  deleteTeamNamespace,
  NamespaceNotTeamsError,
  ProtectedNamespaceError,
  setTeamNamespace,
  type TeamNamespaceState,
} from "../k8s.js";
import { checkSecretStoreObjects } from "../secretStores.js";
import type { FastifyReply } from "fastify";

/** A team's name is also its namespace's: a DNS label. */
const TeamName = Type.String({ pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" });

/**
 * Sets the team's namespace label when the console manages team
 * namespaces (config.teamNamespaces); sends a 4xx itself, and returns
 * false, when the namespace can't be a team's.
 */
async function teamNamespaceOrReply(
  name: string,
  state: TeamNamespaceState,
  createIfMissing: boolean,
  reply: FastifyReply,
): Promise<boolean> {
  if (!config.teamNamespaces.manage) return true;
  try {
    await setTeamNamespace(name, state, { ...config.teamNamespaces, createIfMissing });
    if (state === "true") await copyPullSecret(name);
    return true;
  } catch (error) {
    if (error instanceof ProtectedNamespaceError) {
      reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: error.message });
      return false;
    }
    if (error instanceof NamespaceNotTeamsError) {
      reply.code(409).send({ error: "NAMESPACE_EXISTS", message: error.message });
      return false;
    }
    throw error;
  }
}

const TERMINAL_EXECUTION_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Executions touching this team that haven't finished. Asks kernel-api for
 * live states (getExecutionStates asks in batches); if kernel-api can't
 * answer, this throws, so a purge fails closed instead of proceeding on a
 * guess. Every one of the team's executions, not a page: a purge must see
 * them all. */
async function unfinishedExecutionIds(teamName: string): Promise<string[]> {
  const ids = (await listSubmittedExecutionsForTeams([teamName])).map((row) => row.executionId);
  const states = await getExecutionStates(ids);
  return states.filter(({ state }) => !TERMINAL_EXECUTION_STATES.has(state)).map(({ executionId }) => executionId);
}

/**
 * Team/membership management. Creating a team is a platform-level action:
 * only a platform admin, or an automation token holding `teams:create`
 * (catalog CI's apply-teams.yml, see auth/scopes.ts), may do it. A team is
 * also a Kubernetes namespace that tasks get dispatched into, so it isn't
 * something any registered user should be able to mint.
 *
 * The creator is deliberately *not* made a member. Admins already reach
 * every team, and making catalog CI a member of every team it created was
 * how one leaked CI token came to control every platform. A new team
 * starts empty; an admin adds its first members.
 *
 * Growing an existing team stays self-service *within* that team: a member,
 * or a platform admin (`authUser.isAdmin`), can add another member.
 */
const teamsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/teams", { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser?.isAdmin) {
      reply.code(403).send({ error: "FORBIDDEN", message: "Admin access required." });
      return;
    }
    reply.send(await listAllTeams());
  });

  app.post(
    "/teams",
    {
      schema: { body: Type.Object({ name: TeamName }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin && !hasScope(request.authUser, SCOPES.TEAMS_CREATE)) {
        reply.code(403).send({
          error: "FORBIDDEN",
          message: "Creating a team requires admin access (or an automation token with teams:create).",
        });
        return;
      }
      const existing = await findTeamByNameIncludingDeleted(request.body.name);
      if (existing?.deletedAt) {
        // A distinct code, not the plain "already exists" a re-run of
        // apply-teams.yml treats as success: a purged platform's name can't
        // be reused (see schema.ts's teams.deletedAt), and CI must fail on
        // that rather than carry on as if the team existed.
        reply.code(409).send({
          error: "NAME_RESERVED",
          message: `"${request.body.name}" belonged to a team that was purged, and team names are never reused.`,
        });
        return;
      }
      if (existing) {
        reply.code(409).send({ error: "CONFLICT", message: "Team already exists." });
        return;
      }
      // The namespace first: a name that can't be a team's namespace never
      // becomes a team.
      if (!(await teamNamespaceOrReply(request.body.name, "true", true, reply))) return;
      const team = await createTeam(request.body.name);
      request.log.info({ team: team.name, createdBy: request.authUser?.id }, "team created");
      reply.code(201).send(team);
    },
  );

  /**
   * Makes sure a team exists and is active, with its namespace: what the
   * catalog's apply-teams workflow calls for every team folder, any
   * number of times. Creates the team if it's new (teams:create), un-retires
   * it if it was retired (teams:retire too: a team folder restored),
   * and puts its namespace's label back if it drifted. A purged team's name
   * stays refused.
   */
  app.put(
    "/teams/:teamName",
    { schema: { params: Type.Object({ teamName: TeamName }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      if (!authUser || (!authUser.isAdmin && !hasScope(authUser, SCOPES.TEAMS_CREATE))) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access or teams:create." });
        return;
      }
      const name = request.params.teamName;
      const existing = await findTeamByNameIncludingDeleted(name);
      if (existing?.deletedAt) {
        reply.code(409).send({
          error: "NAME_RESERVED",
          message: `"${name}" belonged to a team that was purged, and team names are never reused.`,
        });
        return;
      }
      if (existing?.retiredAt && !authUser.isAdmin && !hasScope(authUser, SCOPES.TEAMS_RETIRE)) {
        reply.code(403).send({ error: "FORBIDDEN", message: `"${name}" is retired; un-retiring it requires teams:retire.` });
        return;
      }
      if (!(await teamNamespaceOrReply(name, "true", true, reply))) return;
      if (!existing) {
        const team = await createTeam(name);
        request.log.info({ team: name, createdBy: authUser.id }, "team created");
        reply.code(201).send({ ...team, created: true });
        return;
      }
      if (existing.retiredAt) {
        await setTeamRetired(existing.id, false);
        request.log.info({ team: name, by: authUser.id }, "team un-retired");
      }
      reply.send({ ...existing, retiredAt: null, created: false });
    },
  );

  /**
   * One team's record, for its members, admins, and an automation token
   * that creates teams (teams:create, catalog CI). Anyone else gets the
   * same 404 as for a team that doesn't exist, so team names can't be
   * probed. A purged team is still returned (with `deletedAt` set): its
   * name is reserved.
   */
  app.get(
    "/teams/:teamName",
    { schema: { params: Type.Object({ teamName: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      const allowed =
        authUser !== undefined && (canActForTeam(authUser, request.params.teamName) || hasScope(authUser, SCOPES.TEAMS_CREATE));
      const team = allowed ? await findTeamByNameIncludingDeleted(request.params.teamName) : undefined;
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      reply.send(team);
    },
  );

  app.post(
    "/teams/:teamName/members",
    {
      schema: {
        params: Type.Object({ teamName: Type.String() }),
        body: Type.Object({ email: Type.String({ format: "email" }) }),
      },
      preHandler: app.authenticate,
      // "No such user" tells a member whether an email has an account,
      // which adding by email can't avoid; this keeps it from being used to
      // sweep a list of addresses. Per caller (their token, hashed), since
      // the caller isn't known yet when the limit is checked.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 hour",
          keyGenerator: (request) =>
            `members:${createHash("sha256").update(request.headers.authorization ?? request.ip).digest("hex")}`,
        },
      },
    },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (replyIfRetired(team, reply)) return;
      const user = await findUserByEmail(request.body.email);
      if (!user) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such user." });
        return;
      }
      await addTeamMember(user.id, team.id);
      reply.code(204).send();
    },
  );

  /** No listing endpoint existed until now -- a team could only ever
   * grow (POST above), never be inspected, which meant the console's own
   * Members tab had nothing to actually show besides the add-member
   * form. */
  app.get(
    "/teams/:teamName/members",
    { schema: { params: Type.Object({ teamName: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      reply.send(await listMembersForTeam(team.id));
    },
  );

  /**
   * Remove someone from a team: same rule as adding (a member or an admin).
   * A team never loses its last human member this way, since nobody but an
   * admin could then manage it; add the replacement first. Bots can always
   * be removed (their tokens stop granting anything for this team).
   */
  app.delete(
    "/teams/:teamName/members/:userId",
    {
      schema: { params: Type.Object({ teamName: Type.String(), userId: Type.String({ format: "uuid" }) }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (replyIfNotTeamMember(request.authUser, request.params.teamName, reply)) return;
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (replyIfRetired(team, reply)) return;
      const members = await listMembersForTeam(team.id);
      const target = members.find((m) => m.id === request.params.userId);
      if (!target) {
        reply.code(404).send({ error: "NOT_FOUND", message: "Not a member of this team." });
        return;
      }
      const humans = members.filter((m) => !m.isBot);
      if (!target.isBot && humans.length === 1) {
        reply.code(409).send({
          error: "LAST_MEMBER",
          message: `${target.email} is the only person in "${team.name}". Add someone else first.`,
        });
        return;
      }
      await removeTeamMember(target.id, team.id);
      request.log.info(
        { team: team.name, removed: target.email, removedBy: request.authUser?.id },
        "team member removed",
      );
      reply.code(204).send();
    },
  );

  /**
   * Retire: the reversible first step of removing a platform (catalog CI
   * calls this when a team's folder is removed). The team becomes
   * read-only -- see routes that check `retiredAt` -- and its products are
   * unregistered. Members keep access to its history. Idempotent.
   *
   * Its namespace is relabelled `acyclix/team=retired` (when the console
   * manages team namespaces), which stops the kernel dispatching new steps
   * there; anything already running finishes.
   */
  app.post(
    "/teams/:teamName/retire",
    { schema: { params: Type.Object({ teamName: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.authUser?.isAdmin && !hasScope(request.authUser, SCOPES.TEAMS_RETIRE)) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access or teams:retire." });
        return;
      }
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      // The namespace first: once it's labelled retired, the kernel's
      // dispatch policy starts no new step there.
      if (!(await teamNamespaceOrReply(team.name, "retired", false, reply))) return;
      if (!team.retiredAt) await setTeamRetired(team.id, true);
      const unregisteredProducts = await deleteProductsForTeam(team.id);
      await syncIdentityPolicy();
      request.log.info(
        { team: team.name, by: request.authUser?.id, unregisteredProducts },
        "team retired",
      );
      reply.send({ name: team.name, retired: true, unregisteredProducts });
    },
  );

  /** Undo a retire (e.g. a team's folder was restored). Products come
   * back on that platform's next catalog CI push. Idempotent. */
  app.post(
    "/teams/:teamName/unretire",
    { schema: { params: Type.Object({ teamName: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.authUser?.isAdmin && !hasScope(request.authUser, SCOPES.TEAMS_RETIRE)) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access or teams:retire." });
        return;
      }
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (!(await teamNamespaceOrReply(team.name, "true", true, reply))) return;
      if (team.retiredAt) await setTeamRetired(team.id, false);
      request.log.info({ team: team.name, by: request.authUser?.id }, "team un-retired");
      reply.send({ name: team.name, retired: false });
    },
  );

  /**
   * Purge: irreversible. Only a retired team, and only once none of its
   * executions are still running. Removes memberships, secret grants and
   * products, revokes bots left with no team, and soft-deletes the team so
   * its name stays reserved. Execution history is kept.
   *
   * Then deletes its namespace, when the console manages team namespaces
   * and is allowed to purge them (config.teamNamespaces.purge; the kernel
   * chart's purge policy lets it delete only a retired one). Calling it
   * again for an already-purged team only retries the namespace deletion.
   * The catalog's purge workflow handles images and the GitHub Environment.
   */
  app.delete(
    "/teams/:teamName",
    { schema: { params: Type.Object({ teamName: Type.String() }) }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.authUser?.isAdmin && !hasScope(request.authUser, SCOPES.TEAMS_DELETE)) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access or teams:delete." });
        return;
      }
      const team = await findTeamByNameIncludingDeleted(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      // Whether its namespace goes too: otherwise it stays labelled
      // retired, for an operator to delete.
      const namespaceDeleted = config.teamNamespaces.manage && config.teamNamespaces.purge;
      const purgeNamespace = async () => {
        if (namespaceDeleted) await deleteTeamNamespace(team.name, config.teamNamespaces.protected);
      };
      if (team.deletedAt) {
        await purgeNamespace();
        reply.send({ name: team.name, purged: true, alreadyPurged: true, revokedBotTokens: 0, namespaceDeleted });
        return;
      }
      if (!team.retiredAt) {
        reply.code(409).send({
          error: "NOT_RETIRED",
          message: `Team "${team.name}" must be retired before it can be purged.`,
        });
        return;
      }
      const unfinished = await unfinishedExecutionIds(team.name);
      if (unfinished.length > 0) {
        reply.code(409).send({
          error: "EXECUTIONS_RUNNING",
          message: `Team "${team.name}" still has ${String(unfinished.length)} unfinished execution(s); cancel them or wait before purging.`,
          executionIds: unfinished,
        });
        return;
      }
      const { revokedBotTokens } = await purgeTeam(team.id);
      await syncIdentityPolicy();
      await purgeNamespace();
      request.log.info({ team: team.name, by: request.authUser?.id, revokedBotTokens }, "team purged");
      reply.send({ name: team.name, purged: true, revokedBotTokens, namespaceDeleted });
    },
  );

  /**
   * Applies a team's reviewed SecretStore file (the catalog's
   * teams/<team>/secret-stores/*.yaml, parsed to JSON): its
   * SecretStores and the ServiceAccounts ESO signs in as, in the team's
   * namespace, after secretStores.ts's checks. `credential`, when the
   * store's provider needs a stored one (a 1Password token), goes to the
   * Secret eso-auth. Only catalog CI's token (secret-stores:apply) or an
   * admin: a SecretStore decides which vault identity a team can read, so it
   * comes through catalog review, never straight from a team.
   */
  app.put(
    "/teams/:teamName/secret-store",
    {
      schema: {
        params: Type.Object({ teamName: Type.String() }),
        body: Type.Object({
          documents: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 20 }),
          credential: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      if (!request.authUser?.isAdmin && !hasScope(request.authUser, SCOPES.SECRET_STORES_APPLY)) {
        reply.code(403).send({ error: "FORBIDDEN", message: "Requires admin access or secret-stores:apply." });
        return;
      }
      const team = await findTeamByName(request.params.teamName);
      if (!team) {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such team." });
        return;
      }
      if (replyIfRetired(team, reply)) return;
      const checked = checkSecretStoreObjects(team.name, request.body.documents);
      if (checked.problems.length > 0) {
        reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: "The SecretStore file isn't allowed.", problems: checked.problems });
        return;
      }
      await applySecretStoreObjects(team.name, checked.objects, request.body.credential);
      request.log.info(
        { team: team.name, by: request.authUser?.id, objects: checked.objects.map((o) => `${o.kind}/${o.metadata.name}`) },
        "secret store applied",
      );
      reply.code(204).send();
    },
  );
};

export default teamsRoutes;
