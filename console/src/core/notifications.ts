// SPDX-License-Identifier: MIT
/**
 * NotificationService: your inbox, and your teams' chat webhooks
 * (notifier.ts makes and posts the notifications). Anyone signed in reads
 * and clears their own; a team's members see its webhook's host and state,
 * and its maintainers set, test and remove it. The URL is never sent back.
 */
import { Code } from "@connectrpc/connect";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureTeamMaintainer, ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { findTeamByName } from "../db/queries.js";
import { notificationEvents, teamWebhooks, userNotifications, users, type NotificationKind } from "../db/schema.js";
import { decryptUrl, encryptUrl, postToWebhook, webhookUrlProblem } from "../notifier.js";
import { ensureNotRetired } from "./retired.js";

/** The kinds a team's webhook can get: a person's own runs finishing stay in their inbox. */
export const WEBHOOK_KINDS: NotificationKind[] = ["run_failed", "approval_waiting", "product_not_ready"];

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

export async function listNotifications(caller: AuthUser | undefined, unreadOnly: boolean) {
  const who = signedIn(caller);
  const mine = eq(userNotifications.userId, who.id);
  const rows = await db
    .select({ event: notificationEvents, readAt: userNotifications.readAt })
    .from(userNotifications)
    .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
    .where(and(mine, unreadOnly ? isNull(userNotifications.readAt) : undefined))
    .orderBy(desc(notificationEvents.createdAt))
    .limit(50);
  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userNotifications)
    .where(and(mine, isNull(userNotifications.readAt)));
  return {
    notifications: rows.map((r) => ({ ...r.event, read: r.readAt !== null })),
    unreadCount: unread?.n ?? 0,
  };
}

export async function markNotificationsRead(caller: AuthUser | undefined, ids: string[], all: boolean): Promise<void> {
  const who = signedIn(caller);
  if (!all && ids.length === 0) return;
  await db
    .update(userNotifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(userNotifications.userId, who.id), isNull(userNotifications.readAt), all ? undefined : inArray(userNotifications.eventId, ids)));
}

async function teamNamed(name: string) {
  const team = await findTeamByName(name);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team "${name}".`);
  return team;
}

function view(row: typeof teamWebhooks.$inferSelect | undefined) {
  return row
    ? { configured: true, host: row.host, kinds: row.kinds, lastSentAt: row.lastSentAt, lastError: row.lastError ?? "", updatedAt: row.updatedAt }
    : { configured: false, host: "", kinds: [] as NotificationKind[], lastSentAt: null, lastError: "", updatedAt: null };
}

export async function getTeamWebhook(caller: AuthUser | undefined, teamName: string) {
  const who = signedIn(caller);
  ensureTeamMember(who, teamName);
  const team = await teamNamed(teamName);
  const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, team.id));
  return { webhook: view(row), allowedHosts: config.notifications.webhookHosts };
}

/** Sets a team's webhook: a new URL, or (url empty) only which kinds the one it has gets. */
export async function setTeamWebhook(caller: AuthUser | undefined, teamName: string, url: string, kinds: string[]) {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  ensureNotRetired(team);
  const wanted = [...new Set(kinds)];
  const unknown = wanted.filter((k) => !(WEBHOOK_KINDS as string[]).includes(k));
  if (unknown.length > 0) throw new ApiError(400, "BAD_REQUEST", `A webhook can get ${WEBHOOK_KINDS.join(" and ")}, not ${unknown.join(", ")}.`);
  const [existing] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, team.id));
  let fields: { urlEncrypted: string; host: string } | undefined;
  if (url) {
    const problem = webhookUrlProblem(url);
    if (problem) throw new ApiError(400, "WEBHOOK_URL", problem);
    fields = { urlEncrypted: encryptUrl(url), host: new URL(url).hostname };
  } else if (!existing) {
    throw new ApiError(400, "WEBHOOK_URL", "Give the webhook's URL.");
  }
  const values = { kinds: wanted as NotificationKind[], updatedBy: who.id, updatedAt: new Date(), ...(fields ? { ...fields, lastError: null } : {}) };
  const [row] = existing
    ? await db.update(teamWebhooks).set(values).where(eq(teamWebhooks.teamId, team.id)).returning()
    : await db.insert(teamWebhooks).values({ teamId: team.id, ...values, urlEncrypted: fields?.urlEncrypted ?? "", host: fields?.host ?? "" }).returning();
  return { webhook: view(row) };
}

export async function deleteTeamWebhook(caller: AuthUser | undefined, teamName: string): Promise<void> {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  await db.delete(teamWebhooks).where(eq(teamWebhooks.teamId, team.id));
}

export async function testTeamWebhook(caller: AuthUser | undefined, teamName: string): Promise<{ sent: boolean; error: string }> {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, team.id));
  if (!row) throw new ApiError(404, "NOT_FOUND", `Team "${teamName}" has no webhook.`);
  const url = decryptUrl(row.urlEncrypted);
  try {
    if (!url) throw new Error("The stored webhook URL can't be read (the console's key changed): set it again.");
    await postToWebhook(url, `Vertra: ${teamName}'s notifications will come here (a test).`);
    await db.update(teamWebhooks).set({ lastSentAt: sql`now()`, lastError: null }).where(eq(teamWebhooks.teamId, team.id));
    return { sent: true, error: "" };
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await db.update(teamWebhooks).set({ lastError: why }).where(eq(teamWebhooks.teamId, team.id));
    return { sent: false, error: why };
  }
}

const EMAIL_KINDS: NotificationKind[] = ["run_failed", "run_succeeded", "approval_waiting", "product_not_ready", "catalog_failing"];

export async function emailPreferences(caller: AuthUser | undefined) {
  const who = signedIn(caller);
  const [row] = await db.select({ kinds: users.emailKinds }).from(users).where(eq(users.id, who.id));
  return { available: config.notifications.email.host !== "", kinds: row?.kinds ?? [] };
}

export async function setEmailPreferences(caller: AuthUser | undefined, kinds: string[]) {
  const who = signedIn(caller);
  const wanted = [...new Set(kinds)];
  const unknown = wanted.filter((k) => !(EMAIL_KINDS as string[]).includes(k));
  if (unknown.length > 0) throw new ApiError(400, "BAD_REQUEST", `Not a kind of notification: ${unknown.join(", ")}.`);
  const [row] = await db.update(users).set({ emailKinds: wanted as NotificationKind[] }).where(eq(users.id, who.id)).returning({ kinds: users.emailKinds });
  return { kinds: row?.kinds ?? [] };
}
