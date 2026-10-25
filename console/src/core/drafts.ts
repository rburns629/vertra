// SPDX-License-Identifier: MIT
/**
 * DraftService: Compose's drafts, kept for the team each is for, so its
 * members (and admins) see and change them from any device. A draft's body
 * is the page's own state, kept as it is and bounded. Every save names the
 * version it changed and is one conditional statement, so of two people
 * saving the same version one is refused (DRAFT_CHANGED) rather than lost.
 */
import { Code } from "@connectrpc/connect";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { findTeamByName } from "../db/queries.js";
import { composeDrafts, teams, users } from "../db/schema.js";
import { ensureNotRetired } from "./retired.js";

export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_DRAFTS_PER_TEAM = 100;

export interface DraftView {
  team: string;
  name: string;
  body: Record<string, unknown>;
  version: number;
  updatedBy: string;
  updatedAt: Date;
}

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

async function teamNamed(name: string) {
  const team = await findTeamByName(name);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team "${name}".`);
  return team;
}

const columns = {
  team: teams.name,
  name: composeDrafts.name,
  body: composeDrafts.body,
  version: composeDrafts.version,
  updatedBy: sql<string>`coalesce(${users.email}, '')`,
  updatedAt: composeDrafts.updatedAt,
};

/** A team's drafts, or those of every team the caller is in (every team's, for an admin), newest first. */
export async function listDrafts(caller: AuthUser | undefined, teamName: string): Promise<DraftView[]> {
  const who = signedIn(caller);
  if (teamName) ensureTeamMember(who, teamName);
  const names = teamName ? [teamName] : who.isAdmin ? null : who.teamNames;
  if (names?.length === 0) return [];
  return db
    .select(columns)
    .from(composeDrafts)
    .innerJoin(teams, eq(teams.id, composeDrafts.teamId))
    .leftJoin(users, eq(users.id, composeDrafts.updatedBy))
    .where(and(isNull(teams.deletedAt), names ? inArray(teams.name, names) : undefined))
    .orderBy(desc(composeDrafts.updatedAt));
}

async function stored(teamId: string, name: string): Promise<DraftView | undefined> {
  const [row] = await db
    .select(columns)
    .from(composeDrafts)
    .innerJoin(teams, eq(teams.id, composeDrafts.teamId))
    .leftJoin(users, eq(users.id, composeDrafts.updatedBy))
    .where(and(eq(composeDrafts.teamId, teamId), eq(composeDrafts.name, name)));
  return row;
}

async function current(teamId: string, name: string): Promise<number> {
  const [row] = await db
    .select({ version: composeDrafts.version })
    .from(composeDrafts)
    .where(and(eq(composeDrafts.teamId, teamId), eq(composeDrafts.name, name)));
  return row?.version ?? 0;
}

function changed(teamName: string, name: string, version: number): ApiError {
  return new ApiError(
    409,
    "DRAFT_CHANGED",
    version === 0
      ? `Team "${teamName}" has no draft called "${name}" any more.`
      : `Draft "${name}" of team "${teamName}" was saved by someone else since: load it again, then make your change.`,
    Code.FailedPrecondition,
    { version },
  );
}

/** Saves a draft: a new one at version 0, else the version it changed. */
export async function saveDraft(
  caller: AuthUser | undefined,
  input: { team: string; name: string; body: Record<string, unknown>; version: number },
): Promise<DraftView> {
  const who = signedIn(caller);
  ensureTeamMember(who, input.team);
  const team = await teamNamed(input.team);
  ensureNotRetired(team);
  if (Buffer.byteLength(JSON.stringify(input.body)) > MAX_DRAFT_BYTES) {
    throw new ApiError(400, "DRAFT_TOO_LARGE", `A draft is at most ${String(MAX_DRAFT_BYTES / 1024)} KiB.`);
  }
  let saved: { version: number } | undefined;
  if (input.version === 0) {
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(composeDrafts).where(eq(composeDrafts.teamId, team.id));
    if (n >= MAX_DRAFTS_PER_TEAM) {
      throw new ApiError(400, "TOO_MANY_DRAFTS", `Team "${team.name}" has ${String(MAX_DRAFTS_PER_TEAM)} drafts: delete one first.`);
    }
    [saved] = await db
      .insert(composeDrafts)
      .values({ teamId: team.id, name: input.name, body: input.body, updatedBy: who.id })
      .onConflictDoNothing({ target: [composeDrafts.teamId, composeDrafts.name] })
      .returning({ version: composeDrafts.version });
  } else {
    [saved] = await db
      .update(composeDrafts)
      .set({ body: input.body, version: sql`${composeDrafts.version} + 1`, updatedBy: who.id, updatedAt: new Date() })
      .where(and(eq(composeDrafts.teamId, team.id), eq(composeDrafts.name, input.name), eq(composeDrafts.version, input.version)))
      .returning({ version: composeDrafts.version });
  }
  if (!saved) {
    const now = await current(team.id, input.name);
    if (input.version === 0) {
      throw new ApiError(409, "DRAFT_CHANGED", `Team "${team.name}" already has a draft called "${input.name}".`, Code.FailedPrecondition, { version: now });
    }
    throw changed(team.name, input.name, now);
  }
  const view = await stored(team.id, input.name);
  if (!view) throw changed(team.name, input.name, 0); // deleted just now
  return view;
}

export async function deleteDraft(caller: AuthUser | undefined, teamName: string, name: string): Promise<void> {
  const who = signedIn(caller);
  ensureTeamMember(who, teamName);
  const team = await teamNamed(teamName);
  ensureNotRetired(team);
  await db.delete(composeDrafts).where(and(eq(composeDrafts.teamId, team.id), eq(composeDrafts.name, name)));
}
