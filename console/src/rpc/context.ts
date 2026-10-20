// SPDX-License-Identifier: MIT
/**
 * What a Connect handler knows about its request, beyond the message:
 * set once per request in rpc/server.ts from what Fastify resolved.
 */
import { createContextKey, type HandlerContext } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import type { AuthUser } from "../auth/plugin.js";
import { unauthenticated } from "./errors.js";

/** The signed-in caller; unset when there's no valid credential. */
export const kCaller = createContextKey<AuthUser | undefined>(undefined, { description: "caller" });
/** Why there's no caller, for the error a protected method answers with. */
export const kAuthProblem = createContextKey<string | undefined>(undefined, { description: "auth problem" });
/** An error resolving the credential (a database failure, say): the call
 * fails with it, masked, rather than going on as if nobody had signed in. */
export const kAuthError = createContextKey<Error | undefined>(undefined, { description: "auth error" });
/** The client's address, as Fastify resolved it (trustProxy). */
export const kClientIp = createContextKey<string>("", { description: "client ip" });
export const kRequestId = createContextKey<string>("", { description: "request id" });
export const kLog = createContextKey<FastifyBaseLogger | undefined>(undefined, { description: "logger" });

/** The caller; every method but the public ones has one (interceptors.ts). */
export function callerOf(ctx: HandlerContext) {
  const caller = ctx.values.get(kCaller);
  if (!caller) throw unauthenticated(ctx.values.get(kAuthProblem));
  return caller;
}

/** The request's logger; rpc/server.ts always sets it. */
export function logOf(ctx: HandlerContext): FastifyBaseLogger {
  const log = ctx.values.get(kLog);
  if (!log) throw new Error("A Connect call without its request's logger.");
  return log;
}
