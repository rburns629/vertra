// SPDX-License-Identifier: MIT
/**
 * What finished runs made (decision 21, docs/assessment.md): every 30
 * seconds, the runs not yet looked at that have finished have the
 * resources their succeeded steps reported (`resources: [{type, id, name,
 * link}]` in their outputs) copied into the resources table, with each
 * step's resolved inputs and outputs, so a resource can be deleted after
 * its run is gone. A run that ran a delete (core/resources.ts) marks what it
 * deleted. A retried run is recorded again once it finishes. A run the kernel no longer has
 * is passed over. A failed pass is logged and the next one tries again:
 * nothing is marked recorded until it is.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { productLookup, productOfTask } from "./core/executions.js";
import { db } from "./db/client.js";
import { resources, submittedExecutions } from "./db/schema.js";
import { getExecution, getExecutionStates, type KernelExecution } from "./kernel/client.js";

const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
/** Runs looked at, and finished ones read in full, per pass. */
const PER_PASS = 500;
const READ_PER_PASS = 50;
const MAX_PER_STEP = 100;

export interface Reported {
  type: string;
  id: string;
  name: string | null;
  link: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

/**
 * The resources a step's outputs report. They come from a product's
 * container, so each is checked: a type and an id, an optional name, an
 * optional http(s) link; anything else is left out, as are any past the
 * first hundred.
 */
export function reportedResources(outputs: Record<string, unknown> | null): Reported[] {
  const list = outputs?.["resources"];
  if (!Array.isArray(list)) return [];
  const out: Reported[] = [];
  for (const item of list.slice(0, MAX_PER_STEP)) {
    if (!isRecord(item)) continue;
    const type = text(item["type"], 128);
    const id = text(item["id"], 512);
    if (!type || !id) continue;
    const link = text(item["link"], 2048);
    out.push({ type, id, name: text(item["name"], 256), link: link && /^https?:\/\//.test(link) ? link : null });
  }
  return out;
}

/** A task's inputs with each {$fromTask, $output} replaced by that output, as the kernel resolved them. */
export function resolvedInputs(inputs: unknown, outputs: Map<string, Record<string, unknown>>): Record<string, unknown> {
  if (!isRecord(inputs)) return {};
  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => {
      if (isRecord(value) && typeof value["$fromTask"] === "string" && typeof value["$output"] === "string" && Object.keys(value).length === 2) {
        return [name, outputs.get(value["$fromTask"])?.[value["$output"]] ?? null];
      }
      return [name, value];
    }),
  );
}

/** Each task's place in its run: after everything it depends on. */
function positions(tasks: Record<string, unknown>[]): Map<string, number> {
  const order = new Map<string, number>();
  const pending = [...tasks];
  while (pending.length > 0) {
    const ready = pending.findIndex((t) =>
      (Array.isArray(t["dependsOn"]) ? t["dependsOn"] : []).every((d: unknown) => typeof d !== "string" || order.has(d) || !tasks.some((x) => x["id"] === d)),
    );
    const [task] = pending.splice(ready === -1 ? 0 : ready, 1);
    if (task && typeof task["id"] === "string") order.set(task["id"], order.size);
  }
  return order;
}

type Run = Pick<typeof submittedExecutions.$inferSelect, "executionId" | "submittedBy" | "payload" | "template" | "onBehalfOf">;

/** Copies one finished run's resources, marks what its deletes removed, and marks it recorded. */
export async function recordRun(run: Run, detail: KernelExecution): Promise<number> {
  const tasks = isRecord(run.payload) && Array.isArray(run.payload["tasks"]) ? run.payload["tasks"].filter(isRecord) : [];
  const outputs = new Map(detail.tasks.flatMap((t) => (t.outputs ? [[t.taskId, t.outputs as Record<string, unknown>] as const] : [])));
  const state = new Map(detail.tasks.map((t) => [t.taskId, t.state]));
  const order = positions(tasks);
  const products = productLookup();
  const rows: (typeof resources.$inferInsert)[] = [];
  for (const task of tasks) {
    const id = typeof task["id"] === "string" ? task["id"] : "";
    if (state.get(id) !== "SUCCEEDED") continue;
    const reported = reportedResources(outputs.get(id) ?? null);
    if (reported.length === 0) continue;
    const product = await productOfTask(products, task);
    // Only a team's registered product's: its team owns the type and id, and
    // its cleanup is what deletes them. A step runs its own team's products
    // (or the platform's, which have no team), so that's the step's team.
    const team = typeof task["team"] === "string" ? task["team"] : null;
    if (!product?.teamId || !team) continue;
    for (const r of reported) {
      rows.push({
        product: product.name,
        productTeam: team,
        type: r.type,
        externalId: r.id,
        name: r.name,
        link: r.link,
        // A template's (or action's) run is for its team, or its person
        // alone; a DAG is its steps' teams'.
        ownerTeam: run.template !== null ? run.onBehalfOf : team,
        ownerUserId: run.submittedBy,
        executionId: run.executionId,
        taskId: id,
        inputs: resolvedInputs(task["inputs"], outputs),
        outputs: outputs.get(id) ?? {},
        position: order.get(id) ?? 0,
      });
    }
  }
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(resources)
        .values(row)
        .onConflictDoUpdate({
          target: [resources.productTeam, resources.type, resources.externalId],
          // A later step reporting it again: the newest record wins, and a
          // deleted one made again exists again.
          set: {
            product: row.product,
            name: row.name,
            link: row.link,
            ownerTeam: row.ownerTeam,
            ownerUserId: row.ownerUserId,
            executionId: row.executionId,
            taskId: row.taskId,
            inputs: row.inputs,
            outputs: row.outputs,
            position: row.position,
            reportedAt: sql`now()`,
            deletedAt: null,
          },
        });
    }
    // This run's deletes: done where their step succeeded. One that didn't
    // stays this run's last attempt, free to be asked for again, or to
    // succeed if the run is retried (and so recorded again).
    const deleting = await tx.select({ id: resources.id, taskId: resources.deletingTaskId }).from(resources).where(eq(resources.deletingExecutionId, run.executionId));
    for (const r of deleting) {
      if (state.get(r.taskId ?? "") === "SUCCEEDED") {
        await tx.update(resources).set({ deletedAt: sql`now()` }).where(and(eq(resources.id, r.id), isNull(resources.deletedAt)));
      }
    }
    await tx.update(submittedExecutions).set({ resourcesRecordedAt: sql`now()` }).where(eq(submittedExecutions.executionId, run.executionId));
  });
  return rows.length;
}

/** One pass: finished runs not yet recorded, oldest first. */
export async function recordFinishedRuns(): Promise<{ runs: number; resources: number }> {
  const pending = await db
    .select({
      executionId: submittedExecutions.executionId,
      submittedBy: submittedExecutions.submittedBy,
      payload: submittedExecutions.payload,
      template: submittedExecutions.template,
      onBehalfOf: submittedExecutions.onBehalfOf,
    })
    .from(submittedExecutions)
    .where(isNull(submittedExecutions.resourcesRecordedAt))
    .orderBy(asc(submittedExecutions.createdAt))
    .limit(PER_PASS);
  if (pending.length === 0) return { runs: 0, resources: 0 };
  const states = new Map((await getExecutionStates(pending.map((r) => r.executionId))).map((s) => [s.executionId, s.state]));
  let runs = 0;
  let recorded = 0;
  for (const run of pending) {
    const state = states.get(run.executionId);
    if (state === undefined) {
      // The kernel no longer has it (past its retention): nothing to read.
      await db
        .update(submittedExecutions)
        .set({ resourcesRecordedAt: sql`now()` })
        .where(and(eq(submittedExecutions.executionId, run.executionId), isNull(submittedExecutions.resourcesRecordedAt)));
      continue;
    }
    if (!FINISHED.has(state) || runs === READ_PER_PASS) continue;
    recorded += await recordRun(run, await getExecution(run.executionId));
    runs += 1;
  }
  return { runs, resources: recorded };
}

export function startResourceRecorder(log: FastifyBaseLogger): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    recordFinishedRuns()
      .then((done) => {
        if (done.resources > 0) log.info({ event: "resources_recorded", ...done }, "recorded what finished runs made");
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't record what finished runs made");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
