// SPDX-License-Identifier: MIT
/**
 * What runs made, and deleting it (ResourceService; decision 21,
 * docs/assessment.md). resourceRecorder.ts copies each resource a step
 * reported, with that step's inputs and outputs, when its run finishes.
 *
 * Who sees one: the team the run was for (or, for a run for nobody's team,
 * whoever ran it), the team whose product reported it, and admins. Who
 * deletes one: the team it was for, whoever ran it, and admins. Deleting
 * runs its product's current cleanup action (product.yaml's cleanup) as a
 * run of its own, for that team, with the same checks as running the
 * action: it must be shared with them, and approvals apply. Several are
 * deleted in one run, newest first, one after another. A resource is
 * deleted once its step succeeds (resourceRecorder.ts).
 */
import type { FastifyBaseLogger } from "fastify";
import { Code } from "@connectrpc/connect";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { findRunnableProduct } from "../db/queries.js";
import { resources, submittedExecutions, users } from "../db/schema.js";
import { runCleanup, type CleanupStep, type TeamProduct } from "./templates.js";

export type ResourceState = "exists" | "deleting" | "delete_failed" | "deleted";

export interface ResourceView {
  id: string;
  type: string;
  externalId: string;
  name: string | null;
  link: string | null;
  /** The registered product whose step reported it, and its team. */
  product: string;
  productTeam: string;
  /** The team it was made for (null: for whoever ran it alone), and who ran it. */
  ownerTeam: string | null;
  ownerEmail: string | null;
  /** The run and step that last reported it. */
  executionId: string;
  taskId: string;
  firstReportedAt: Date;
  reportedAt: Date;
  state: ResourceState;
  /** The last delete asked for: its run. */
  deletingExecutionId: string | null;
  deletedAt: Date | null;
  /** Whether the caller may delete it now: theirs to delete, there, and its product says how. */
  canDelete: boolean;
}

export interface ResourceFilter {
  executionId?: string | undefined;
  team?: string | undefined;
  /** Matched against type, id and name. */
  query?: string | undefined;
  includeDeleted?: boolean | undefined;
}

const LIST_LIMIT = 200;
const DELETE_LIMIT = 50;

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** Rows the caller may see. */
function visibleTo(who: AuthUser): SQL | undefined {
  if (who.isAdmin) return undefined;
  const teams = who.teamNames.length > 0 ? who.teamNames : [""];
  return or(inArray(resources.ownerTeam, teams), inArray(resources.productTeam, teams), eq(resources.ownerUserId, who.id));
}

function mayDelete(who: AuthUser, row: { ownerTeam: string | null; ownerUserId: string | null }): boolean {
  return who.isAdmin || row.ownerUserId === who.id || (row.ownerTeam !== null && who.teamNames.includes(row.ownerTeam));
}

async function select(where: (SQL | undefined)[], limit: number) {
  return db
    .select({
      resource: resources,
      ownerEmail: users.email,
      // The last delete's run has been looked at since it finished: not in progress.
      deleteFinished: isNotNull(submittedExecutions.resourcesRecordedAt).mapWith(Boolean),
      deleteRunKnown: isNotNull(submittedExecutions.executionId).mapWith(Boolean),
    })
    .from(resources)
    .leftJoin(users, eq(users.id, resources.ownerUserId))
    .leftJoin(submittedExecutions, eq(submittedExecutions.executionId, resources.deletingExecutionId))
    .where(and(...where))
    .orderBy(desc(resources.firstReportedAt), desc(resources.position))
    .limit(limit);
}

type Row = Awaited<ReturnType<typeof select>>[number];

function stateOf(row: Row): ResourceState {
  const r = row.resource;
  if (r.deletedAt) return "deleted";
  if (!r.deletingExecutionId) return "exists";
  // Its run gone (past retention) or finished without deleting it.
  if (!row.deleteRunKnown || row.deleteFinished) return "delete_failed";
  return "deleting";
}

async function view(who: AuthUser, rows: Row[]): Promise<ResourceView[]> {
  const cleanable = new Map<string, boolean>();
  for (const name of new Set(rows.map((row) => row.resource.product))) {
    cleanable.set(name, (await findRunnableProduct(name))?.cleanup != null);
  }
  return rows.map((row) => {
    const r = row.resource;
    const state = stateOf(row);
    return {
      id: r.id,
      type: r.type,
      externalId: r.externalId,
      name: r.name,
      link: r.link,
      product: r.product,
      productTeam: r.productTeam,
      ownerTeam: r.ownerTeam,
      ownerEmail: row.ownerEmail,
      executionId: r.executionId,
      taskId: r.taskId,
      firstReportedAt: r.firstReportedAt,
      reportedAt: r.reportedAt,
      state,
      deletingExecutionId: r.deletingExecutionId,
      deletedAt: r.deletedAt,
      canDelete: (state === "exists" || state === "delete_failed") && mayDelete(who, r) && (cleanable.get(r.product) ?? false),
    };
  });
}

/** What the caller may see of what runs made, newest first: a run's, a team's, or matching a search. */
export async function listResources(caller: AuthUser | undefined, filter: ResourceFilter): Promise<ResourceView[]> {
  const who = signedIn(caller);
  const query = filter.query?.trim();
  const rows = await select(
    [
      visibleTo(who),
      filter.executionId ? eq(resources.executionId, filter.executionId) : undefined,
      filter.team ? or(eq(resources.ownerTeam, filter.team), eq(resources.productTeam, filter.team)) : undefined,
      query
        ? or(
            ilike(resources.type, `%${escapeLike(query)}%`),
            ilike(resources.externalId, `%${escapeLike(query)}%`),
            ilike(resources.name, `%${escapeLike(query)}%`),
          )
        : undefined,
      filter.includeDeleted ? undefined : isNull(resources.deletedAt),
    ],
    LIST_LIMIT,
  );
  return view(who, rows);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A cleanup action's inputs for one resource: {"resource": ...} unless
 * product.yaml maps them, from the reporting step's recorded inputs and
 * outputs and the resource itself.
 */
export function cleanupInputs(
  mapping: Record<string, unknown> | null,
  recorded: { inputs: Record<string, unknown>; outputs: Record<string, unknown>; type: string; externalId: string; name: string | null; link: string | null },
): Record<string, unknown> {
  const resource = {
    type: recorded.type,
    id: recorded.externalId,
    ...(recorded.name ? { name: recorded.name } : {}),
    ...(recorded.link ? { link: recorded.link } : {}),
  };
  if (!mapping) return { resource };
  const fields: Record<string, unknown> = resource;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapping)) {
    const ref = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
    const [kind, field] = ref.length === 1 ? (ref[0] ?? []) : [];
    const picked =
      kind === "$input" ? recorded.inputs[String(field)] : kind === "$output" ? recorded.outputs[String(field)] : kind === "$resource" ? fields[String(field)] : value;
    // A field the step didn't have is left out, as a template's missing parameter is.
    if (picked !== undefined) out[name] = picked;
  }
  return out;
}

/** The cleanup action of the product that reported a resource, as registered now. */
async function cleanupOf(productName: string, label: string): Promise<{ product: TeamProduct; mapping: Record<string, unknown> | null }> {
  const reporter = await findRunnableProduct(productName);
  if (!reporter) {
    throw new ApiError(409, "CLEANUP_UNAVAILABLE", `${label}: ${productName}, which made it, isn't registered here any more (or its team is retired).`);
  }
  if (!reporter.cleanup) {
    throw new ApiError(409, "NO_CLEANUP", `${label}: ${productName} doesn't say how to delete what it makes (its product.yaml has no cleanup).`);
  }
  const suffix = `-${reporter.action}`;
  const base = reporter.name.endsWith(suffix) ? reporter.name.slice(0, -suffix.length) : reporter.name;
  const product = await findRunnableProduct(`${base}-${reporter.cleanup.action}`);
  if (!product || product.teamName !== reporter.teamName) {
    throw new ApiError(409, "CLEANUP_UNAVAILABLE", `${label}: ${productName}'s cleanup action, ${reporter.cleanup.action}, isn't registered here.`);
  }
  return { product, mapping: reporter.cleanup.inputs };
}

/**
 * Deletes resources: one run of their products' cleanup actions, newest
 * first, for the team they were made for. All must be the caller's to
 * delete, there now, and made for the same team.
 */
export async function deleteResources(caller: AuthUser | undefined, ids: string[], log: FastifyBaseLogger): Promise<{ executionId: string }> {
  const who = signedIn(caller);
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > DELETE_LIMIT) {
    throw new ApiError(400, "BAD_REQUEST", `Name 1 to ${String(DELETE_LIMIT)} resources to delete.`);
  }
  const rows = await select([inArray(resources.id, unique), visibleTo(who)], DELETE_LIMIT);
  if (rows.length !== unique.length) throw new ApiError(404, "NOT_FOUND", "A resource to delete wasn't found.");
  const owners = new Set(rows.map((row) => row.resource.ownerTeam));
  if (owners.size > 1) throw new ApiError(422, "MIXED_OWNERS", "These were made for different teams: delete each team's separately.");
  const steps: CleanupStep[] = [];
  for (const row of rows) {
    const r = row.resource;
    const label = `${r.type} ${r.externalId}`;
    if (!mayDelete(who, r)) {
      throw new ApiError(403, "FORBIDDEN", `${label} isn't yours to delete: ask team "${r.ownerTeam ?? r.productTeam}".`);
    }
    const state = stateOf(row);
    if (state === "deleted") throw new ApiError(409, "ALREADY_DELETED", `${label} is already deleted.`);
    if (state === "deleting") throw new ApiError(409, "DELETE_IN_PROGRESS", `${label} is being deleted already.`);
    const { product, mapping } = await cleanupOf(r.product, label);
    steps.push({ product, inputs: cleanupInputs(mapping, r), label });
  }
  const ownerTeam = rows[0]?.resource.ownerTeam ?? undefined;
  // For the team it was made for, when the caller is in it (else an admin or the person alone).
  const forTeam = ownerTeam && who.teamNames.includes(ownerTeam) ? ownerTeam : undefined;
  const name = rows.length === 1 ? `Delete ${rows[0]?.resource.type ?? ""} ${rows[0]?.resource.externalId ?? ""}` : `Delete ${String(rows.length)} resources`;
  const { executionId, stepIds } = await runCleanup(who, name.slice(0, 200), steps, forTeam, rows.map((row) => row.resource.id), log);
  await db.transaction(async (tx) => {
    for (const [i, row] of rows.entries()) {
      await tx
        .update(resources)
        .set({ deletingExecutionId: executionId, deletingTaskId: stepIds[i] ?? null, deleteRequestedBy: who.id })
        .where(eq(resources.id, row.resource.id));
    }
  });
  log.info({ event: "resources_delete_requested", executionId, resources: rows.map((row) => row.resource.id) }, "asked to delete resources");
  return { executionId };
}

/** Deletes what a run made that's still there and the caller may delete (its product says how), in the reverse of the order it was made. */
export async function deleteRunResources(caller: AuthUser | undefined, executionId: string, log: FastifyBaseLogger): Promise<{ executionId: string }> {
  const who = signedIn(caller);
  const rows = await select([eq(resources.executionId, executionId), visibleTo(who), isNull(resources.deletedAt)], DELETE_LIMIT);
  const deletable = (await view(who, rows)).filter((r) => r.canDelete);
  if (deletable.length === 0) throw new ApiError(404, "NOT_FOUND", "Nothing this run made is left for you to delete.");
  return deleteResources(caller, deletable.map((r) => r.id), log);
}

