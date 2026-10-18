// SPDX-License-Identifier: MIT
/**
 * Thin client for kernel-api (kernel/app/api/routes/executions.py). Every
 * call here is made only after routes/executions.ts has already checked
 * the caller is allowed to touch the execution/team in question --
 * kernel-api itself has no concept of users or teams and never will (see
 * docs/architecture.md), so this service is the only
 * place that authorization can happen.
 *
 * Payloads are forwarded largely as-is (`unknown` in, `unknown` out) --
 * kernel-api's own Pydantic models are the authority on the full
 * ExecutionSubmission/TaskDefinition shape; duplicating that validation
 * here would just be a second copy to keep in sync forever. This layer
 * only needs to see enough structure to authorize (see routes/executions.ts),
 * not to re-validate everything kernel-api already will.
 */
import { readFile } from "node:fs/promises";

import { config } from "../config.js";

export class KernelApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`kernel-api responded ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

async function kernelRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { body } = await kernelResponse(path, options);
  return body as T;
}

/** kernelRequest, with the status code too. */
async function kernelResponse(path: string, options: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (config.kernelApiTokenFile) {
    // Re-read every time: the kubelet replaces the file before the token expires.
    const token = (await readFile(config.kernelApiTokenFile, "utf8")).trim();
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${config.kernelApiUrl}${path}`, { ...options, headers });
  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => null);
  if (!response.ok) {
    throw new KernelApiError(response.status, body);
  }
  return { status: response.status, body };
}

export interface ExecutionSubmissionResponse {
  executionId: string;
  state: string;
}

export interface SubmittedExecutionResult extends ExecutionSubmissionResponse {
  /** False when the requestId was used before: kernel-api returned that
   * execution (200) instead of starting a new one (201). */
  created: boolean;
}

export async function submitExecution(payload: unknown): Promise<SubmittedExecutionResult> {
  const { status, body } = await kernelResponse("/v1/executions", { method: "POST", body: JSON.stringify(payload) });
  const { executionId, state } = body as ExecutionSubmissionResponse;
  return { executionId, state, created: status === 201 };
}

export function getExecution(executionId: string): Promise<unknown> {
  return kernelRequest(`/v1/executions/${encodeURIComponent(executionId)}`);
}

export interface ExecutionStateEntry {
  executionId: string;
  state: string;
}

/** Per call to kernel-api, which takes at most 1000 (MAX_STATES_PER_REQUEST). */
const STATES_BATCH = 500;

/** Many executions' states for a list view, in batches; nothing to ask
 * for an empty list. */
export async function getExecutionStates(executionIds: string[]): Promise<ExecutionStateEntry[]> {
  const states: ExecutionStateEntry[] = [];
  for (let i = 0; i < executionIds.length; i += STATES_BATCH) {
    const page = await kernelRequest<{ states: ExecutionStateEntry[] }>("/v1/executions/states", {
      method: "POST",
      body: JSON.stringify({ ids: executionIds.slice(i, i + STATES_BATCH) }),
    });
    states.push(...page.states);
  }
  return states;
}

export function getExecutionEvents(executionId: string, after?: number): Promise<unknown> {
  const query = after !== undefined ? `?after=${String(after)}` : "";
  return kernelRequest(`/v1/executions/${encodeURIComponent(executionId)}/events${query}`);
}

/** Every task's captured container output for this execution, in one call
 * -- see kernel/app/contracts/execution.py's ExecutionLogsResponse for why
 * this isn't split into one call per task. */
export function getExecutionLogs(executionId: string): Promise<unknown> {
  return kernelRequest(`/v1/executions/${encodeURIComponent(executionId)}/logs`);
}

export function cancelExecution(executionId: string): Promise<ExecutionSubmissionResponse> {
  return kernelRequest(`/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
    method: "POST",
  });
}

export function retryTask(
  executionId: string,
  taskId: string,
): Promise<ExecutionSubmissionResponse> {
  return kernelRequest(
    `/v1/executions/${encodeURIComponent(executionId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" },
  );
}
