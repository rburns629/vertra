// SPDX-License-Identifier: MIT
/** ExecutionService (proto/acyclix/console/v1/execution.proto): core/executions.ts over Connect. */
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { fromJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import {
  cancel,
  ExecutionId,
  executionDetail,
  executionEvents,
  executionLogs,
  listExecutions,
  ListQuery,
  rerun,
  retry,
  submit,
} from "../../core/executions.js";
import {
  DagSchema,
  ExecutionState,
  TaskState,
  type Dag,
  type ExecutionService,
} from "../../gen/acyclix/console/v1/execution_pb.js";
import { KernelApiError } from "../../kernel/client.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { rpcError } from "../errors.js";
import { check } from "../validate.js";

/**
 * How often a watch re-reads its execution (each read re-checks the
 * caller's access); how often it sends the execution unchanged, so a load
 * balancer's idle timeout doesn't cut a quiet stream; and how long one
 * lasts before the client reconnects.
 */
const WATCH_INTERVAL_MS = 2000;
const WATCH_HEARTBEAT_MS = 15_000;
const WATCH_MAX_MS = 10 * 60 * 1000;
const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

const EXECUTION_STATE: Record<string, ExecutionState> = {
  PENDING: ExecutionState.PENDING,
  RUNNING: ExecutionState.RUNNING,
  SUCCEEDED: ExecutionState.SUCCEEDED,
  FAILED: ExecutionState.FAILED,
  CANCELLED: ExecutionState.CANCELLED,
};
const TASK_STATE: Record<string, TaskState> = {
  BLOCKED: TaskState.BLOCKED,
  READY: TaskState.READY,
  CLAIMED: TaskState.CLAIMED,
  RUNNING: TaskState.RUNNING,
  SUCCEEDED: TaskState.SUCCEEDED,
  FAILED: TaskState.FAILED,
  CANCELLED: TaskState.CANCELLED,
};
const executionState = (state: unknown) =>
  (typeof state === "string" ? EXECUTION_STATE[state] : undefined) ?? ExecutionState.UNSPECIFIED;

/**
 * kernel-api's refusals as Connect errors. A 401 or 403 is about the
 * console's own credentials, not the caller's: unavailable, never
 * unauthenticated (a client would take that for an expired session).
 */
async function viaKernel<T>(ctx: HandlerContext, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof KernelApiError)) throw error;
    if (error.status === 401 || error.status === 403) {
      logOf(ctx).error(
        { kernelStatus: error.status, kernelBody: error.body },
        "kernel-api refused the console's credentials; check kernelApiToken and api.auth",
      );
      throw rpcError(
        Code.Unavailable,
        "BAD_GATEWAY",
        "The console couldn't authenticate to the execution kernel. An administrator needs to check its configuration.",
      );
    }
    const detail = (error.body as { detail?: unknown } | null)?.detail;
    const message = typeof detail === "string" ? detail : JSON.stringify(detail ?? error.body);
    const code =
      error.status === 404 ? Code.NotFound : error.status === 409 ? Code.FailedPrecondition : Code.InvalidArgument;
    throw rpcError(code, `KERNEL_${String(error.status)}`, message);
  }
}

/** A DAG message as the JSON a REST client submits: only what it set. */
function submission(dag: Dag | undefined): Record<string, unknown> | undefined {
  if (!dag) return undefined;
  return {
    name: dag.name,
    ...(dag.requestId ? { requestId: dag.requestId } : {}),
    tasks: dag.tasks.map((task) => ({
      id: task.id,
      image: task.image,
      action: task.action,
      team: task.team,
      ...(task.serviceAccount === undefined ? {} : { serviceAccount: task.serviceAccount }),
      dependsOn: task.dependsOn,
      secretRefs: task.secretRefs,
      inputs: task.inputs ?? {},
      ...(task.timeoutSeconds === undefined ? {} : { timeoutSeconds: task.timeoutSeconds }),
      ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
      ...(task.resources
        ? {
            resources: Object.fromEntries(
              Object.entries({
                cpu: task.resources.cpu,
                memory: task.resources.memory,
                memoryLimit: task.resources.memoryLimit,
              }).filter(([, v]) => v !== undefined),
            ),
          }
        : {}),
    })),
  };
}

/**
 * The stored DAG as a message; unset if it can't be read as one. Rows from
 * before the rename say externalReference and idempotencyKey.
 */
function storedDag(payload: unknown): Dag | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const { externalReference, idempotencyKey, ...rest } = payload as Record<string, unknown>;
  const renamed = { name: externalReference, requestId: idempotencyKey, ...rest };
  try {
    return fromJson(DagSchema, JSON.parse(JSON.stringify(renamed)) as JsonValue, { ignoreUnknownFields: true });
  } catch {
    return undefined;
  }
}

type Detail = Awaited<ReturnType<typeof executionDetail>>;

/** kernel-api's own fields of a detail (ExecutionDetailResponse), which core passes through untyped. */
const kernelFields = (detail: Detail) => detail as Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function execution(detail: Detail) {
  const kernel = kernelFields(detail);
  const tasks = Array.isArray(kernel["tasks"]) ? (kernel["tasks"] as Record<string, unknown>[]) : [];
  const failure = (value: unknown) => {
    const f = value as { code?: unknown; message?: unknown; retryable?: unknown } | null | undefined;
    return f
      ? {
          code: text(f.code),
          message: text(f.message),
          retryable: f.retryable === true,
        }
      : undefined;
  };
  return {
    executionId: text(kernel["executionId"]),
    name: text(kernel["name"]),
    state: executionState(kernel["state"]),
    tasks: tasks.map((task) => ({
      taskId: text(task["taskId"]),
      state: (typeof task["state"] === "string" ? TASK_STATE[task["state"]] : undefined) ?? TaskState.UNSPECIFIED,
      attemptCount: Number(task["attemptCount"] ?? 0),
      outputs: (task["outputs"] ?? undefined) as JsonObject | undefined,
      failure: failure(task["failure"]),
      dependsOn: (task["dependsOn"] as string[] | undefined) ?? [],
      startedAt: timestamp(task["startedAt"] as string | null | undefined),
      completedAt: timestamp(task["completedAt"] as string | null | undefined),
    })),
    teams: detail.teams,
    submittedBy: detail.submittedBy ?? "",
    createdAt: timestamp(detail.createdAt),
    dag: storedDag(detail.payload),
    runBlocked: detail.runBlocked
      ? {
          code: detail.runBlocked.error,
          message: detail.runBlocked.message,
          missingImages: detail.runBlocked.missingImages ?? [],
          disallowedImages: detail.runBlocked.disallowedImages ?? [],
          allowedSources: detail.runBlocked.allowedSources ?? [],
        }
      : undefined,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function executionService(): ServiceImpl<typeof ExecutionService> {
  return {
    async listExecutions(req, ctx) {
      const query = check(
        { query: ListQuery },
        {
          query: Object.fromEntries(
            Object.entries({
              limit: unsetIfEmpty(req.page?.limit ?? 0),
              cursor: unsetIfEmpty(req.page?.cursor ?? ""),
              since: req.since ? new Date(Number(req.since.seconds) * 1000).toISOString() : undefined,
              team: unsetIfEmpty(req.team),
              search: unsetIfEmpty(req.search),
            }).filter(([, v]) => v !== undefined),
          ),
        },
      ).query;
      const page = await listExecutions(callerOf(ctx), query, logOf(ctx));
      return {
        executions: page.executions.map((row) => ({
          executionId: row.executionId,
          name: row.name,
          teams: row.teams,
          submittedBy: row.submittedBy ?? undefined,
          createdAt: timestamp(row.createdAt),
          state: executionState(row.state),
        })),
        nextCursor: page.nextCursor ?? "",
      };
    },

    async submitExecution(req, ctx) {
      const result = await viaKernel(ctx, () => submit(callerOf(ctx), submission(req.dag), logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async getExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      return {
        execution: execution(await viaKernel(ctx, () => executionDetail(callerOf(ctx), executionId, logOf(ctx)))),
      };
    },

    async *watchExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const caller = callerOf(ctx);
      const until = Date.now() + WATCH_MAX_MS;
      let last = "";
      let sentAt = 0;
      while (!ctx.signal.aborted && Date.now() < until) {
        const detail = await viaKernel(ctx, () => executionDetail(caller, executionId, logOf(ctx)));
        const seen = JSON.stringify(detail);
        if (seen !== last || Date.now() - sentAt >= WATCH_HEARTBEAT_MS) {
          last = seen;
          sentAt = Date.now();
          yield { execution: execution(detail) };
        }
        if (FINISHED.has(text(kernelFields(detail)["state"]))) return;
        await wait(WATCH_INTERVAL_MS, ctx.signal);
      }
    },

    async listExecutionEvents(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const after = unsetIfEmpty(Number(req.after));
      const page = (await viaKernel(ctx, () => executionEvents(callerOf(ctx), executionId, after))) as {
        events: {
          id: number;
          eventType: string;
          taskId: string | null;
          payload: JsonObject;
          createdAt: string;
        }[];
        nextCursor: number | null;
      };
      return {
        events: page.events.map((event) => ({
          id: BigInt(event.id),
          eventType: event.eventType,
          taskId: event.taskId ?? undefined,
          payload: event.payload,
          createdAt: timestamp(event.createdAt),
        })),
        nextCursor: BigInt(page.nextCursor ?? 0),
      };
    },

    async getExecutionLogs(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const logs = (await viaKernel(ctx, () => executionLogs(callerOf(ctx), executionId))) as {
        tasks: { taskId: string; lines: string[] }[];
      };
      return { tasks: logs.tasks };
    },

    async cancelExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const result = await viaKernel(ctx, () => cancel(callerOf(ctx), executionId));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async retryTask(req, ctx) {
      const { executionId, taskId } = check({ executionId: ExecutionId, taskId: Type.String({ minLength: 1 }) }, req);
      const result = await viaKernel(ctx, () => retry(callerOf(ctx), executionId, taskId, logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async rerunExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const result = await viaKernel(ctx, () => rerun(callerOf(ctx), executionId, logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },
  };
}
