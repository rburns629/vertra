// SPDX-License-Identifier: MIT
/**
 * What every Connect call goes through, outermost first (rpc/server.ts):
 *
 * 1. maskErrors: an error that isn't a ConnectError (a database or
 *    Kubernetes failure, whose message can carry the cluster's response
 *    body) is logged in full and answered `internal` with a generic
 *    message, as the REST error handler does for a 5xx.
 * 2. audit: a method that can change something is recorded once answered,
 *    allowed or refused, with its request's identifying fields only
 *    (audit.ts). Reads aren't, nor sign-in and passwords.
 * 3. requireCaller: every method but the few public ones needs a valid
 *    credential; one that couldn't be checked (the database failed) fails
 *    the call, whatever the method.
 */
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { toJson, type JsonObject } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { ApiError } from "../apiError.js";
import { targetFields, writeAuditEntry } from "../audit.js";
import { AuthService } from "../gen/vertra/console/v1/auth_pb.js";
import { ProblemSchema } from "../gen/vertra/console/v1/common_pb.js";
import { kAuthError, kAuthProblem, kCaller, kLog, kRequestId } from "./context.js";
import { httpStatusFor, rpcError, unauthenticated } from "./errors.js";

const procedure = (service: { typeName: string }, method: { name: string }) => `${service.typeName}/${method.name}`;

/** Methods anyone may call, signed in or not. */
export const PUBLIC = new Set(
  [AuthService.method.getEnvironment, AuthService.method.register, AuthService.method.login].map((m) =>
    procedure(m.parent, m),
  ),
);

/** Changes nothing worth recording, or carries secrets: never audited. */
const UNAUDITED = new Set(
  [AuthService.method.register, AuthService.method.login, AuthService.method.changePassword].map((m) =>
    procedure(m.parent, m),
  ),
);

const GENERIC = "Internal server error.";

export const maskErrors: Interceptor = (next) => async (req) => {
  const log = req.contextValues.get(kLog);
  const mask = (error: unknown): ConnectError => {
    if (error instanceof ConnectError) return error;
    // An expected refusal from the shared logic (apiError.ts), with any
    // problems it lists as Problem details: each a message, or a message
    // about a field ({field, message}: a template's parameters, say).
    if (error instanceof ApiError) {
      const { problems, ...rest } = error.extra;
      const detail = Object.keys(rest).length > 0 ? (JSON.parse(JSON.stringify(rest)) as JsonObject) : undefined;
      const refusal = rpcError(error.connectCode, error.code, error.message, false, detail);
      if (Array.isArray(problems)) {
        for (const problem of problems as unknown[]) {
          const { field, message } =
            typeof problem === "object" && problem !== null
              ? (problem as { field?: unknown; message?: unknown })
              : { field: "", message: problem };
          refusal.details.push({
            desc: ProblemSchema,
            value: { field: typeof field === "string" ? field : "", code: error.code, message: String(message) },
          });
        }
      }
      return refusal;
    }
    log?.error({ err: error, procedure: procedure(req.service, req.method) }, "rpc failed");
    return new ConnectError(GENERIC, Code.Internal);
  };
  let res;
  try {
    res = await next(req);
  } catch (error) {
    throw mask(error);
  }
  if (!res.stream) return res;
  const messages = res.message;
  return {
    ...res,
    message: (async function* () {
      try {
        yield* messages;
      } catch (error) {
        throw mask(error);
      }
    })(),
  };
};

export const audit: Interceptor = (next) => async (req) => {
  const name = procedure(req.service, req.method);
  if (req.method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS || UNAUDITED.has(name)) {
    return next(req);
  }
  let status = 200;
  try {
    return await next(req);
  } catch (error) {
    // A refusal from the shared logic records the status REST would have.
    status = error instanceof ApiError ? error.statusCode : httpStatusFor(ConnectError.from(error).code);
    throw error;
  } finally {
    const log = req.contextValues.get(kLog);
    const target = req.stream ? {} : targetFields(toJson(req.method.input, req.message));
    if (log) {
      await writeAuditEntry(log, {
        actorId: req.contextValues.get(kCaller)?.id ?? null,
        method: "RPC",
        route: name,
        target,
        status,
        requestId: req.contextValues.get(kRequestId),
      });
    }
  }
};

export const requireCaller: Interceptor = (next) => async (req) => {
  const authError = req.contextValues.get(kAuthError);
  if (authError !== undefined) throw authError;
  if (!PUBLIC.has(procedure(req.service, req.method)) && !req.contextValues.get(kCaller)) {
    throw unauthenticated(req.contextValues.get(kAuthProblem));
  }
  return next(req);
};
