// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  cancelExecution,
  getExecution,
  getExecutionEvents,
  getExecutionLogs,
  getExecutionStates,
  KernelApiError,
  retryTask,
  submitExecution,
} from "../kernel/client.js";
import {
  findTeamByName,
  findTeamByNameIncludingDeleted,
  findUserById,
  listProductsUsableBy,
  listSubmittedExecutionsPage,
  InvalidCursorError,
  isSecretRegistered,
  recordSubmittedExecution,
  type Product,
} from "../db/queries.js";
import {
  allowedPrefixes,
  imageRefusal,
  imageRepository,
  readImagePolicy,
  readImagePolicyForDisplay,
  type ImagePolicy,
} from "../imagePolicy.js";
import { loadExecutionOrReply, replyIfNotTeamMember } from "../auth/access.js";
import { ensureServiceAccount, NamespaceNotFoundError } from "../k8s.js";
import { UNREGISTERED_SERVICE_ACCOUNT } from "../productPolicy.js";
import { missingImages, pinImages } from "../registry.js";
import { config } from "../config.js";
import { scanBlocker } from "../scanning.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structural validation only -- just enough to extract every task's
 * `team` for the authorization check below. kernel-api's own Pydantic
 * models (app/contracts/task.py, app/contracts/execution.py) are the
 * actual authority on the full shape; duplicating that here would be a
 * second copy of the same contract, guaranteed to drift eventually.
 * Deliberately not a Fastify/TypeBox body schema either -- ajv validating
 * against a schema can reshape (or strip additional properties from) the
 * body, and this handler needs to forward the caller's JSON to kernel-api
 * completely unchanged.
 */
interface TaskAuthInfo {
  team: string;
  // These three undefined when absent or not a string -- kernel-api
  // rejects that task anyway, but it then can't pass the checks below.
  id: string | undefined;
  image: string | undefined;
  action: string | undefined;
  serviceAccount: string | undefined;
  secretRefs: string[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractTasksAuthInfo(body: unknown): TaskAuthInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body["tasks"]) || body["tasks"].length === 0) {
    return null;
  }
  const result: TaskAuthInfo[] = [];
  for (const task of body["tasks"]) {
    if (!isRecord(task) || typeof task["team"] !== "string" || task["team"].length === 0) {
      return null;
    }
    let secretRefs: string[] = [];
    if ("secretRefs" in task) {
      const raw = task["secretRefs"];
      if (!Array.isArray(raw) || !raw.every((s): s is string => typeof s === "string" && s.length > 0)) {
        return null;
      }
      secretRefs = raw;
    }
    result.push({
      team: task["team"],
      id: optionalString(task["id"]),
      image: optionalString(task["image"]),
      action: optionalString(task["action"]),
      serviceAccount: optionalString(task["serviceAccount"]),
      secretRefs,
    });
  }
  return result;
}

interface RunBlocker {
  error:
    | "TEAM_PURGED"
    | "TEAM_RETIRED"
    | "IMAGE_NOT_FOUND"
    | "IMAGE_NOT_ALLOWED"
    | "IMAGE_POLICY_NOT_CONFIGURED"
    | "IMAGE_NOT_RESOLVED";
  message: string;
  missingImages?: string[];
  disallowedImages?: string[];
  allowedSources?: string[];
}

/** Every task's image, for tasks that name one (task ids optional). */
function taskImages(body: unknown, taskId?: string): string[] {
  if (!isRecord(body) || !Array.isArray(body["tasks"])) return [];
  return body["tasks"]
    .filter((task): task is Record<string, unknown> => isRecord(task))
    .filter((task) => taskId === undefined || task["id"] === taskId)
    .map((task) => task["image"])
    .filter((image): image is string => typeof image === "string" && image.length > 0);
}

/** Why these images can't run: one from outside the allowed sources
 * (imagePolicy.ts; the cluster enforces the same rule at dispatch), or one
 * the registry says is gone (registry.ts, which also explains why an
 * unanswered check allows). */
async function imageBlocker(images: string[], policy: ImagePolicy): Promise<RunBlocker | null> {
  const refusal = imageRefusal(images, policy);
  if (refusal) return refusal;
  const missing = await missingImages(images, allowedPrefixes(policy));
  if (missing.length === 0) return null;
  return {
    error: "IMAGE_NOT_FOUND",
    message: `${missing.length === 1 ? "Image" : "Images"} no longer available in the registry: ${missing.join(", ")}.`,
    missingImages: missing,
  };
}

/** For the detail page's up-front notice only; rerun and retry enforce
 * the real check themselves. If the policy can't be read the page still
 * loads, without the notice. */
async function detailImageBlocker(payload: unknown, request: FastifyRequest): Promise<RunBlocker | null> {
  let policy: ImagePolicy;
  try {
    policy = await readImagePolicyForDisplay();
  } catch (error) {
    request.log.warn({ err: error }, "couldn't read the image policy for an execution's rerun notice");
    return null;
  }
  return imageBlocker(taskImages(payload), policy);
}

/**
 * The image check for anything about to run (submit, rerun, retry): sends
 * the 422 and logs who tried to run what, and what was allowed, so a
 * refusal is as clear in the logs as it is in the UI. Reading the policy
 * failing is a real error and propagates (nothing runs on a guess).
 */
async function replyIfImagesBlocked(
  images: string[],
  request: FastifyRequest,
  reply: FastifyReply,
  context: { action: "submit" | "rerun" | "retry"; teams: string[]; executionId?: string },
): Promise<boolean> {
  const blocker = await imageBlocker(images, await readImagePolicy());
  if (!blocker) return false;
  request.log.warn(
    {
      event: blocker.error === "IMAGE_NOT_FOUND" ? "image_not_found" : "image_not_allowed",
      code: blocker.error,
      action: context.action,
      executionId: context.executionId,
      user: request.authUser?.id,
      teams: context.teams,
      images: blocker.disallowedImages ?? blocker.missingImages,
      allowedSources: blocker.allowedSources,
    },
    blocker.message,
  );
  reply.code(422).send(blocker);
  return true;
}

/**
 * Why nothing can run for this team any more, or null when it can. A
 * purged team's namespace and product images are gone, so the kernel would
 * accept the work and then fail every task (DISPATCH_REJECTED, or an image
 * that no longer exists). A retired team is read-only. A name with no
 * console team at all isn't blocked here: admins may still submit for it,
 * and the kernel's dispatch policy decides whether its namespace may run
 * anything.
 */
async function teamRunBlocker(teamName: string): Promise<RunBlocker | null> {
  const team = await findTeamByNameIncludingDeleted(teamName);
  if (team?.deletedAt) {
    return {
      error: "TEAM_PURGED",
      message: `Team "${teamName}" was purged: its namespace and product images no longer exist, so nothing can run for it again.`,
    };
  }
  if (team?.retiredAt) {
    return {
      error: "TEAM_RETIRED",
      message: `Team "${teamName}" is retired, so nothing new can run for it. An admin can un-retire it.`,
    };
  }
  return null;
}

async function runBlocker(teamNames: string[]): Promise<RunBlocker | null> {
  for (const team of teamNames) {
    const blocker = await teamRunBlocker(team);
    if (blocker) return blocker;
  }
  return null;
}

/**
 * kernel-api's answer, passed on: a 404, 409 or 422 is about the request.
 * A 401 or 403 is about the console's own credentials (kernel/app/api/
 * auth.py), not the user's, so it becomes a 502: passed on as a 401, the
 * browser would take it for an expired session and sign the user out.
 */
/**
 * The submission with every task's image pinned to the digest its tag names
 * right now (registry.ts's pinImages): a DAG may say `:latest`, and what
 * runs, what's retried and what's scanned is exactly the image resolved
 * here. Sends a 422 itself, and returns null, when the registry can't say
 * which image a tag is (config.imagePinning "required").
 */
async function pinnedOrReply(
  submission: Record<string, unknown>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Record<string, unknown> | null> {
  const tasks = submission["tasks"];
  if (config.imagePinning === "off" || !Array.isArray(tasks)) return submission;
  const policy = await readImagePolicy();
  const { pinned, unresolved } = await pinImages(taskImages(submission), allowedPrefixes(policy));
  if (unresolved.length > 0) {
    request.log.warn({ event: "image_not_resolved", images: unresolved, user: request.authUser?.id }, "couldn't pin images");
    reply.code(422).send({
      error: "IMAGE_NOT_RESOLVED",
      message:
        `Couldn't ask the registry which image ${unresolved.length === 1 ? "this is" : "these are"}: ` +
        `${unresolved.join(", ")}. Every step runs a pinned image (its digest), so a tag is resolved at ` +
        "submission; try again, or name the image by digest.",
      unresolvedImages: unresolved,
    });
    return null;
  }
  return {
    ...submission,
    tasks: tasks.map((task: unknown) => {
      if (!isRecord(task) || typeof task["image"] !== "string") return task;
      return { ...task, image: pinned.get(task["image"]) ?? task["image"] };
    }),
  };
}

/**
 * Every (pinned) image must have passed its security scan, or been
 * accepted (scanning.ts); sends the refusal itself and returns true when one
 * hasn't: 422 for a failed scan, 409 (try again) for one still running.
 */
async function replyIfScanBlocked(
  images: string[],
  request: FastifyRequest,
  reply: FastifyReply,
  context: { action: "submit" | "rerun" | "retry"; teams: string[]; executionId?: string },
): Promise<boolean> {
  const blocker = await scanBlocker(images);
  if (!blocker) return false;
  request.log.warn(
    {
      event: "image_scan_blocked",
      code: blocker.error,
      action: context.action,
      executionId: context.executionId,
      user: request.authUser?.id,
      teams: context.teams,
      images: blocker.images.map((i) => i.image),
    },
    blocker.message,
  );
  reply.code(blocker.error === "IMAGE_SCAN_FAILED" ? 422 : 409).send(blocker);
  return true;
}

/**
 * Records who may see a just-submitted execution. kernel-api created it first
 * (only then is its id known), so if recording fails a new execution would
 * run where no one could see or stop it: it's cancelled instead, and the
 * error goes back to the caller, who can submit again. A replay (its
 * requestId used before) is left alone: it was recorded the first time.
 */
async function recordOrCancel(
  record: Parameters<typeof recordSubmittedExecution>[0],
  created: boolean,
  request: FastifyRequest,
): Promise<void> {
  try {
    await recordSubmittedExecution(record);
  } catch (error) {
    if (!created) throw error;
    request.log.error({ err: error, executionId: record.executionId }, "couldn't record an execution; cancelling it");
    await cancelExecution(record.executionId).catch((cancelError: unknown) => {
      request.log.error({ err: cancelError, executionId: record.executionId }, "couldn't cancel the unrecorded execution");
    });
    throw error;
  }
}

function relayKernelError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof KernelApiError)) throw error;
  if (error.status === 401 || error.status === 403) {
    reply.log.error(
      { kernelStatus: error.status, kernelBody: error.body },
      "kernel-api refused the console's credentials; check kernelApiToken and api.auth",
    );
    reply.code(502).send({
      error: "BAD_GATEWAY",
      message: "The console couldn't authenticate to the execution kernel. An administrator needs to check its configuration.",
    });
    return;
  }
  reply.code(error.status).send(error.body);
}

// UNREGISTERED_SERVICE_ACCOUNT: the namespace's own ServiceAccount, which
// no product declares and no cloud identity is bound to: any task may run
// as it, with no secrets. Shared with the cluster's copy of this rule
// (productPolicy.ts).

const runsAs = (product: Product) => product.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT;

/**
 * Why this task may not run as the ServiceAccount it names, or mount
 * secrets at all; null when it may. `matching` are the registered products
 * (usable in its team) with its image's repository and its action. Which
 * secrets it may mount is checked after (each must be its team's).
 *
 * A ServiceAccount can carry a cloud identity (a product's GCP service
 * account through Workload Identity, say), so which one a task runs as
 * follows from what it runs: a product runs as the ServiceAccount its
 * reviewed product.yaml declares, and only a product may mount its team's
 * secrets; anything else runs as "default" with none. Running as "default"
 * with no secrets is always allowed, products too: it grants nothing.
 */
function identityRefusal(task: TaskAuthInfo, matching: Product[]): string | null {
  const label = task.id === undefined ? "A task" : `Task "${task.id}"`;
  const serviceAccount = task.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT;
  if (serviceAccount === UNREGISTERED_SERVICE_ACCOUNT && task.secretRefs.length === 0) return null;
  if (matching.length === 0) {
    return (
      `${label} runs "${task.image ?? ""}" (action "${task.action ?? ""}"), which isn't a registered ` +
      `product of team "${task.team}", so it can only run as ServiceAccount ` +
      `"${UNREGISTERED_SERVICE_ACCOUNT}" and mount no secrets.`
    );
  }
  if (!matching.some((product) => runsAs(product) === serviceAccount)) {
    const declared = [...new Set(matching.map(runsAs))].map((name) => `"${name}"`).join(" or ");
    return (
      `${label} runs product "${matching[0]?.name ?? ""}", which runs as ServiceAccount ` +
      `${declared} (its product.yaml), not "${serviceAccount}". Leave serviceAccount out to use its own.`
    );
  }
  return null;
}

/**
 * Finds the registered products a task runs: its image's repository (any
 * tag) and its action, among its team's products and the platform's. Caches
 * each team's lookups for the length of one request.
 */
function productLookup() {
  const teamIds = new Map<string, string | null>();
  const usableByTeamId = new Map<string | null, Product[]>();

  async function teamId(team: string): Promise<string | null> {
    if (!teamIds.has(team)) teamIds.set(team, (await findTeamByName(team))?.id ?? null);
    return teamIds.get(team) ?? null;
  }

  async function matching(team: string, image: string | undefined, action: string | undefined): Promise<Product[]> {
    const id = await teamId(team);
    let usable = usableByTeamId.get(id);
    if (usable === undefined) {
      usable = await listProductsUsableBy(id);
      usableByTeamId.set(id, usable);
    }
    if (image === undefined) return [];
    const repository = imageRepository(image);
    return usable.filter((product) => product.action === action && imageRepository(product.image) === repository);
  }

  return { teamId, matching };
}

/**
 * The submission with each task that names no `serviceAccount` given the
 * one it runs as: its product's, when every registered product it could be
 * declares the same one, otherwise "default". So a DAG needn't know a
 * product's identity, and the stored payload says what actually ran. Run
 * before authorization, which then checks what was filled in.
 */
async function withProductIdentities(submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  const products = productLookup();
  const filled: unknown[] = [];
  for (const task of tasks) {
    const team = isRecord(task) ? optionalString(task["team"]) : undefined;
    if (!isRecord(task) || "serviceAccount" in task || team === undefined) {
      filled.push(task);
      continue;
    }
    const matching = await products.matching(team, optionalString(task["image"]), optionalString(task["action"]));
    const declared = [...new Set(matching.map(runsAs))];
    filled.push({ ...task, serviceAccount: declared.length === 1 ? declared[0] : UNREGISTERED_SERVICE_ACCOUNT });
  }
  return { ...submission, tasks: filled };
}

/**
 * Creates each task's ServiceAccount in its team's namespace if it isn't
 * there yet (a platform product's, in a team it hasn't run in), after
 * authorization: only a product's own reaches here. Never modifies one.
 * Sends a 422 itself, and returns false, for a team with no namespace.
 */
async function ensureServiceAccountsOrReply(tasksInfo: TaskAuthInfo[], reply: FastifyReply): Promise<boolean> {
  const needed = new Set(
    tasksInfo
      .filter((task) => task.serviceAccount !== undefined && task.serviceAccount !== UNREGISTERED_SERVICE_ACCOUNT)
      .map((task) => JSON.stringify([task.team, task.serviceAccount])),
  );
  for (const entry of needed) {
    const [team, serviceAccount] = JSON.parse(entry) as [string, string];
    try {
      await ensureServiceAccount(team, serviceAccount);
    } catch (error) {
      if (!(error instanceof NamespaceNotFoundError)) throw error;
      reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: error.message });
      return false;
    }
  }
  return true;
}

/**
 * The submission with each task that sets no `resources` of its own given its
 * product's, so the size a product declares travels with its tasks to
 * kernel-api (which fills anything still unset from its own default). Run
 * after authorization: the product chosen is the one the task's
 * ServiceAccount runs as, if there's one with a size.
 */
async function withProductResources(submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  const products = productLookup();
  const sized: unknown[] = [];
  for (const task of tasks) {
    const team = isRecord(task) ? optionalString(task["team"]) : undefined;
    if (!isRecord(task) || "resources" in task || team === undefined) {
      sized.push(task);
      continue;
    }
    const matching = await products.matching(team, optionalString(task["image"]), optionalString(task["action"]));
    const serviceAccount = optionalString(task["serviceAccount"]) ?? UNREGISTERED_SERVICE_ACCOUNT;
    const sizedProducts = matching.filter((product) => product.resources);
    const product = sizedProducts.find((p) => runsAs(p) === serviceAccount) ?? sizedProducts[0];
    sized.push(product?.resources ? { ...task, resources: product.resources } : task);
  }
  return { ...submission, tasks: sized };
}

/**
 * The checks every submission gets -- team membership per task, the
 * identity each task runs as, then secretRefs against each team's current
 * secrets -- factored
 * out so /rerun can apply them fresh against *current* membership and
 * grants rather than trusting whatever was true when the original payload
 * was first submitted (a team can lose access to a secret, or a caller can
 * leave a team, in between). Sends the appropriate error itself and
 * returns false when unauthorized; the caller just needs to return early.
 */
async function authorizeTasksOrReply(
  tasksInfo: TaskAuthInfo[],
  authUser: { id: string; teamNames: string[]; isAdmin: boolean } | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  const uniqueTeams = [...new Set(tasksInfo.map((t) => t.team))];
  for (const team of uniqueTeams) {
    if (replyIfNotTeamMember(authUser, team, reply)) return false;
    const blocker = await teamRunBlocker(team);
    if (blocker) {
      reply.code(409).send(blocker);
      return false;
    }
  }

  // kernel runs a task as whatever ServiceAccount, and mounts whatever
  // Secret names, it asks for, with no notion of "team" or "product" to
  // check them against (see KubernetesExecutor._create_job) -- this is the
  // one place that's actually enforced, same as team membership above.
  const products = productLookup();

  // Which ServiceAccount, and which secrets, follow from the product the
  // task runs (identityRefusal).
  for (const task of tasksInfo) {
    const matching = await products.matching(task.team, task.image, task.action);
    const refusal = identityRefusal(task, matching);
    if (refusal) {
      reply.code(403).send({ error: "FORBIDDEN", message: refusal });
      return false;
    }
  }

  // And each secret must be one its team registered. Any of the team's
  // products may mount any of them (only products get this far with
  // secrets); the cluster's identity policy holds the same list.
  for (const { team, secretRefs } of tasksInfo) {
    if (secretRefs.length === 0) continue;
    const teamId = await products.teamId(team);
    if (!teamId) {
      reply.code(422).send({ error: "UNPROCESSABLE_ENTITY", message: `Team "${team}" does not exist.` });
      return false;
    }
    for (const secretName of secretRefs) {
      if (!(await isSecretRegistered(teamId, secretName))) {
        reply.code(403).send({
          error: "FORBIDDEN",
          message: `Secret "${secretName}" is not registered for team "${team}". Add it on the team's Secrets tab.`,
        });
        return false;
      }
    }
  }
  return true;
}

/**
 * A submission with the current field names: `name` (was
 * `externalReference`) and `requestId` (was `idempotencyKey`). Old names are
 * still accepted, from older callers and from DAGs stored before the rename
 * (Rerun); they're to be dropped later (TODO.md). When a caller sends both
 * an old and a new name, nothing is changed, and kernel-api refuses the
 * ambiguous submission.
 */
function withCurrentFieldNames(body: Record<string, unknown>): Record<string, unknown> {
  const renames: Record<string, string> = { externalReference: "name", idempotencyKey: "requestId" };
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => {
      const current = renames[key];
      return current && !(current in body) ? [current, value] : [key, value];
    }),
  );
}

/**
 * kernel-api's requestIds are one namespace for every team, so two teams
 * picking the same one ("hello-1") would get each other's executions back.
 * Prefixing it with the submitting teams keeps each team's requestIds its
 * own, while a retry from the same team still matches. Absent stays absent:
 * kernel-api then starts a new execution every time.
 */
function scopeRequestId(submission: Record<string, unknown>, teams: string[]): Record<string, unknown> {
  const requestId = submission["requestId"];
  if (typeof requestId !== "string" || requestId === "") return submission;
  return { ...submission, requestId: `${[...teams].sort().join("+")}/${requestId}` };
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

/**
 * The authorized front door to kernel-api (kernel/app/api/routes/
 * executions.py), which accepts only this console's ServiceAccount token
 * and has no concept of users or teams -- and never will (see docs/multi-tenant-secrets-
 * design.md). Every route here checks the caller's real team membership
 * (or admin) *before* forwarding anything to kernel-api, using
 * submittedExecutions (db/schema.ts) as the record of which teams may see
 * which execution, since kernel-api itself can't answer that question.
 */
const executionsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * The executions the caller can see, newest first, a page at a time: pass
   * a page's nextCursor back as `cursor` for the next. `team`, `search` (part
   * of the name) and `since` narrow it on the server; status comes from
   * kernel-api, for just this page.
   */
  app.get(
    "/executions",
    {
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
          cursor: Type.Optional(Type.String({ maxLength: 120 })),
          since: Type.Optional(Type.String({ format: "date-time" })),
          team: Type.Optional(Type.String({ minLength: 1 })),
          search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      const { limit = DEFAULT_PAGE_SIZE, cursor, since, team, search } = request.query;
      let page;
      try {
        page = await listSubmittedExecutionsPage({
          visibleTo: authUser?.isAdmin ? null : (authUser?.teamNames ?? []),
          limit,
          cursor,
          since: since === undefined ? undefined : new Date(since),
          team,
          search,
        });
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          reply.code(400).send({ error: "BAD_REQUEST", message: error.message });
          return;
        }
        throw error;
      }

      // Status is display enrichment, not the authorization-scoped list
      // itself (that's `page`, already resolved above) -- if kernel-api is
      // briefly unreachable, the list should still render without status
      // rather than failing the whole page over one non-critical field.
      let statesByExecutionId = new Map<string, string>();
      try {
        const states = await getExecutionStates(page.rows.map((row) => row.executionId));
        statesByExecutionId = new Map(states.map((s) => [s.executionId, s.state]));
      } catch (error) {
        request.log.warn({ err: error }, "Failed to fetch execution states from kernel-api");
      }

      reply.send({
        executions: page.rows.map((row) => ({ ...row, state: statesByExecutionId.get(row.executionId) ?? null })),
        nextCursor: page.nextCursor,
      });
    },
  );

  app.post("/executions", { preHandler: app.authenticate }, async (request, reply) => {
    const body = isRecord(request.body)
      ? await withProductIdentities(withCurrentFieldNames(request.body))
      : request.body;
    const tasksInfo = extractTasksAuthInfo(body);
    if (tasksInfo === null) {
      reply.code(400).send({
        error: "BAD_REQUEST",
        message:
          "Malformed submission: every task must declare a non-empty \"team\", and " +
          "\"secretRefs\" if present must be an array of non-empty strings.",
      });
      return;
    }

    const authUser = request.authUser;
    if (!(await authorizeTasksOrReply(tasksInfo, authUser, reply))) return;
    const teams = [...new Set(tasksInfo.map((t) => t.team))];
    if (await replyIfImagesBlocked(taskImages(body), request, reply, { action: "submit", teams })) return;
    if (!(await ensureServiceAccountsOrReply(tasksInfo, reply))) return;

    const pinnedBody = await pinnedOrReply(body as Record<string, unknown>, request, reply);
    if (!pinnedBody) return;
    if (await replyIfScanBlocked(taskImages(pinnedBody), request, reply, { action: "submit", teams })) return;
    const submission = await withProductResources(pinnedBody);

    let result;
    try {
      result = await submitExecution(scopeRequestId(submission, teams));
    } catch (error) {
      relayKernelError(reply, error);
      return;
    }

    await recordOrCancel(
      {
        executionId: result.executionId,
        teams,
        submittedBy: authUser?.id ?? "",
        name: typeof submission["name"] === "string" ? submission["name"] : "",
        payload: submission,
      },
      result.created,
      request,
    );

    reply.code(result.created ? 201 : 200).send({ executionId: result.executionId, state: result.state });
  });

  app.get(
    "/executions/:id",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "any");
      if (!submitted) return;
      try {
        const detail = await getExecution(request.params.id);
        // No submitter id: that account has since been deleted (its
        // executions are kept, see db/schema.ts).
        const submitter = submitted.submittedBy ? await findUserById(submitted.submittedBy) : undefined;
        const blocker =
          (await runBlocker(submitted.teams)) ?? (await detailImageBlocker(submitted.payload, request));
        // Enriched with what console/ already knows and just looked up above
        // for the authorization check -- kernel-api's own response has no
        // concept of "team" or "who submitted this," so without this the
        // detail page would have nothing to show for either. `payload` is
        // the exact body originally forwarded to kernel-api (or `null` for
        // rows predating that column) -- included so the detail page can
        // show each task's own DAG definition (image, command, dependsOn,
        // etc.) without kernel-api needing to echo submission-time input
        // back out of its own state, which it doesn't. `runBlocked` says
        // why rerun and retry would be refused (the same check they
        // enforce), so the page can say so up front.
        reply.send({
          ...(detail as Record<string, unknown>),
          teams: submitted.teams,
          submittedBy: submitter?.email ?? (submitted.submittedBy === null ? "(deleted account)" : null),
          createdAt: submitted.createdAt,
          payload: submitted.payload,
          runBlocked: blocker,
        });
      } catch (error) {
        relayKernelError(reply, error);
      }
    },
  );

  app.get(
    "/executions/:id/events",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        querystring: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 1 })) }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "any");
      if (!submitted) return;
      try {
        reply.send(await getExecutionEvents(request.params.id, request.query.after));
      } catch (error) {
        relayKernelError(reply, error);
      }
    },
  );

  app.get(
    "/executions/:id/logs",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "any");
      if (!submitted) return;
      try {
        reply.send(await getExecutionLogs(request.params.id));
      } catch (error) {
        relayKernelError(reply, error);
      }
    },
  );

  app.post(
    "/executions/:id/cancel",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) }, preHandler: app.authenticate },
    async (request, reply) => {
      // Every team, as for submitting it: cancelling stops all of its
      // tasks, other teams' as well.
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "every");
      if (!submitted) return;
      try {
        reply.send(await cancelExecution(request.params.id));
      } catch (error) {
        relayKernelError(reply, error);
      }
    },
  );

  app.post(
    "/executions/:id/tasks/:taskId/retry",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }), taskId: Type.String() }),
      },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "any");
      if (!submitted) return;
      // The same checks as rerun, against current membership and grants,
      // over every task: retrying resumes the whole execution, and
      // kernel-api then revives the tasks the failure cancelled, other
      // teams' too, each mounting its secrets again.
      const tasksInfo = submitted.payload === null ? null : extractTasksAuthInfo(submitted.payload);
      if (tasksInfo === null) {
        reply.code(422).send({
          error: "UNPROCESSABLE_ENTITY",
          message:
            "This execution has no stored submission (it predates them, or it's malformed), " +
            "so there's nothing to check a retry's access against.",
        });
        return;
      }
      if (!(await authorizeTasksOrReply(tasksInfo, authUser, reply))) return;
      const images = taskImages(submitted.payload, request.params.taskId);
      const context = { action: "retry" as const, teams: submitted.teams, executionId: request.params.id };
      if (await replyIfImagesBlocked(images, request, reply, context)) return;
      if (await replyIfScanBlocked(images, request, reply, context)) return;
      if (!(await ensureServiceAccountsOrReply(tasksInfo, reply))) return;
      try {
        reply.send(await retryTask(request.params.id, request.params.taskId));
      } catch (error) {
        relayKernelError(reply, error);
      }
    },
  );

  /**
   * Resubmits the original execution's exact task graph as a brand-new
   * execution -- a fresh `executionId`, not a reset of this one, since
   * kernel-api has no concept of "run this again in place" (an execution's
   * attempts/outputs are append-only history, not a slot to overwrite).
   * Re-runs the same team-membership and secret-grant checks POST
   * /executions itself does (via authorizeTasksOrReply), against *current*
   * state -- not just trusting that the original submission was authorized
   * when it happened, since team membership or secret grants can have
   * changed since.
   */
  app.post(
    "/executions/:id/rerun",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) }, preHandler: app.authenticate },
    async (request, reply) => {
      const authUser = request.authUser;
      const submitted = await loadExecutionOrReply(request.params.id, authUser, reply, "any");
      if (!submitted) return;

      if (submitted.payload === null || submitted.payload === undefined) {
        reply.code(422).send({
          error: "UNPROCESSABLE_ENTITY",
          message: "This execution was submitted before rerun support existed, so there's no stored submission to replay.",
        });
        return;
      }

      // Stored DAGs from before the rename get the current field names
      // first, and a task with no serviceAccount the one it runs as now.
      const replayed = isRecord(submitted.payload)
        ? await withProductIdentities(withCurrentFieldNames(submitted.payload))
        : submitted.payload;
      const tasksInfo = extractTasksAuthInfo(replayed);
      if (tasksInfo === null) {
        reply.code(422).send({
          error: "UNPROCESSABLE_ENTITY",
          message: "The stored submission for this execution is malformed and can't be replayed.",
        });
        return;
      }
      if (!(await authorizeTasksOrReply(tasksInfo, authUser, reply))) return;
      const context = { action: "rerun" as const, teams: submitted.teams, executionId: request.params.id };
      if (await replyIfImagesBlocked(taskImages(replayed), request, reply, context)) return;
      if (!(await ensureServiceAccountsOrReply(tasksInfo, reply))) return;

      // Every field carries over except requestId: kernel-api treats it as
      // identifying *this specific submission* (see kernel/app/contracts/
      // execution.py's ExecutionSubmission), so reusing the original would
      // return the same execution instead of starting a new one.
      // A stored DAG from before pinning has tags; they're pinned now.
      const pinnedReplay = await pinnedOrReply(replayed as Record<string, unknown>, request, reply);
      if (!pinnedReplay) return;
      if (await replyIfScanBlocked(taskImages(pinnedReplay), request, reply, context)) return;
      const rerunPayload = await withProductResources({ ...pinnedReplay, requestId: randomUUID() });

      let result;
      try {
        result = await submitExecution(scopeRequestId(rerunPayload, submitted.teams));
      } catch (error) {
        relayKernelError(reply, error);
        return;
      }

      await recordOrCancel(
        {
          executionId: result.executionId,
          teams: submitted.teams,
          submittedBy: authUser?.id ?? "",
          name: submitted.name,
          payload: rerunPayload,
        },
        result.created,
        request,
      );

      reply.code(201).send({ executionId: result.executionId, state: result.state });
    },
  );
};

export default executionsRoutes;
