// SPDX-License-Identifier: MIT
/**
 * API products (decision 20): a backend a team runs, published through the
 * gateway, which forwards only what its OpenAPI document describes. The
 * catalog's release brings them (catalogSync.ts); the gateway reads them
 * from the database. Here: who sees and may call which, whether each is
 * live, held (its backend's host isn't one the admins allow) or paused, and
 * pausing one for an incident.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { canMaintainTeam } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { findApi, listLiveTeamApis, setApiPaused, type ApiRow } from "../db/queries.js";
import type { BackendAuth } from "../db/schema.js";

type Api = ApiRow & { teamName: string };

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a backend URL's host is one the admins allow: exactly, or below a "*." pattern. */
export function backendAllowed(url: string, hosts: string[] = config.gateway.backendHosts): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
  });
}

/** live, held or paused, and why. */
export function apiState(api: Pick<Api, "backendUrl" | "pausedMessage">): { state: "live" | "held" | "paused"; heldReason: string } {
  if (api.pausedMessage !== null) return { state: "paused", heldReason: "" };
  if (!backendAllowed(api.backendUrl)) {
    return {
      state: "held",
      heldReason: `Its backend's host, ${hostOf(api.backendUrl)}, isn't one this install's admins allow (the gateway's backendHosts).`,
    };
  }
  return { state: "live", heldReason: "" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Every operation its spec describes: what the gateway lets through. */
export function endpoints(openapi: unknown): { method: string; path: string; summary: string }[] {
  const paths = isRecord(openapi) && isRecord(openapi["paths"]) ? openapi["paths"] : {};
  const out: { method: string; path: string; summary: string }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const summary = typeof op["summary"] === "string" ? op["summary"] : "";
      out.push({ method: method.toUpperCase(), path, summary });
    }
  }
  return out;
}

function mayCall(caller: AuthUser, api: Api): boolean {
  return caller.teamNames.includes(api.teamName) || api.shareWith.includes("*") || api.shareWith.some((t) => caller.teamNames.includes(t));
}

function sees(caller: AuthUser, api: Api): boolean {
  return !api.hidden || caller.isAdmin || caller.teamNames.includes(api.teamName);
}

/** The most requests a minute any of the caller's teams may send it. */
function perMinuteFor(caller: AuthUser, api: Api): number {
  if (!mayCall(caller, api)) return 0;
  const fallback = api.perMinute["default"] ?? 0;
  return Math.max(fallback, ...caller.teamNames.map((t) => api.perMinute[t] ?? fallback));
}

function authKind(auth: BackendAuth | null): string {
  if (!auth) return "";
  if ("serviceAccountToken" in auth) return "service_account_token";
  if ("googleIdToken" in auth) return "google_id_token";
  return "secret";
}

function joinUrl(base: string, api: Api): string {
  return base ? `${base.replace(/\/$/, "")}/${api.teamName}/${api.name}` : "";
}

function view(caller: AuthUser, api: Api) {
  const own = caller.isAdmin || caller.teamNames.includes(api.teamName);
  const internet = api.internet && config.gateway.internetTeams.includes(api.teamName);
  const info = isRecord(api.openapi) && isRecord(api.openapi["info"]) ? api.openapi["info"] : {};
  return {
    team: api.teamName,
    name: api.name,
    displayName: api.displayName,
    description: api.description,
    ...apiState(api),
    pausedMessage: api.pausedMessage ?? "",
    mayCall: mayCall(caller, api),
    shareWith: api.shareWith,
    hidden: api.hidden,
    deprecated: api.deprecated ?? "",
    internet,
    url: joinUrl(config.gateway.url, api),
    publicUrl: internet ? joinUrl(config.gateway.publicUrl, api) : "",
    endpoints: endpoints(api.openapi),
    perMinute: perMinuteFor(caller, api),
    timeoutSeconds: api.timeoutSeconds,
    maxRequestBytes: api.maxRequestBytes,
    sourcePath: api.sourcePath ?? "",
    backendUrl: own ? api.backendUrl : "",
    backendAuth: own ? authKind(api.backendAuth) : "",
    specTitle: typeof info["title"] === "string" ? info["title"] : "",
    specVersion: typeof info["version"] === "string" ? info["version"] : "",
  };
}

export type ApiView = ReturnType<typeof view>;

export async function listApis(caller: AuthUser | undefined): Promise<ApiView[]> {
  const who = signedIn(caller);
  return (await listLiveTeamApis()).filter((api) => sees(who, api)).map((api) => view(who, api));
}

async function visibleApi(who: AuthUser, team: string, name: string): Promise<Api> {
  const api = await findApi(team, name);
  if (!api || !sees(who, api)) throw new ApiError(404, "NOT_FOUND", `No API "${team}/${name}".`);
  return api;
}

export async function getApi(caller: AuthUser | undefined, team: string, name: string) {
  const who = signedIn(caller);
  const api = await visibleApi(who, team, name);
  return { api: view(who, api), openapi: JSON.stringify(api.openapi) };
}

/** Pauses (a message) or resumes (null) an API; a maintainer of its team or an admin. */
export async function pauseApi(caller: AuthUser | undefined, team: string, name: string, message: string | null): Promise<void> {
  const who = signedIn(caller);
  const api = await visibleApi(who, team, name);
  if (!canMaintainTeam(who, api.teamName)) {
    throw new ApiError(403, "FORBIDDEN", `Only a maintainer of ${api.teamName} may pause or resume its APIs.`);
  }
  if (message !== null && !message.trim()) {
    throw new ApiError(400, "BAD_REQUEST", "Say why it's paused: every caller is told.", Code.InvalidArgument);
  }
  await setApiPaused(api.id, message === null ? null : message.trim(), who.id);
}
