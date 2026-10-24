// SPDX-License-Identifier: MIT
/**
 * Notifications: telling people what happened, in the console's inbox and on
 * their teams' chat webhooks.
 *
 *   - a run that failed: whoever ran it, and its teams' webhooks;
 *   - a run that succeeded: whoever ran it;
 *   - a step waiting for an approval: its team's maintainers (not whoever
 *     ran it, who can't decide) and its team's webhook;
 *   - the catalog not pulled: admins.
 *
 * Each is an event made once (notification_events.key), so a second
 * console or a second pass never says it twice. A finished run is reported
 * by resourceRecorder.ts as it records it; the rest are looked for every 30
 * seconds, when webhooks are posted too, each up to five times.
 *
 * A webhook URL is a credential: it's kept encrypted (AES-256-GCM, with a
 * key derived from the console's JWT_SECRET, so a copy of the database
 * alone doesn't give it away), never sent back, and only to the hosts the
 * install allows (config.notifications.webhookHosts), without following
 * redirects. Rotating JWT_SECRET makes the stored ones unreadable: teams set
 * theirs again.
 */
import type { FastifyBaseLogger } from "fastify";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { config } from "./config.js";
import { backendAllowed } from "./core/apis.js";
import { db } from "./db/client.js";
import { catalogSync, notificationEvents, teamMemberships, teams, teamWebhooks, userNotifications, users, webhookDeliveries, type NotificationKind } from "./db/schema.js";
import { listAwaitingApproval } from "./kernel/client.js";

const MAX_ATTEMPTS = 5;
/** A finished run older than this when it's recorded isn't news (a console's first pass over old runs). */
const NEWS_MS = 60 * 60_000;
/** The catalog failing for this long is worth telling admins. */
const CATALOG_GRACE_MS = 30 * 60_000;

// --- the webhook URL, encrypted ---

const TAG_LENGTH = 16;
const key = () => Buffer.from(hkdfSync("sha256", config.jwtSecret, "vertra", "notification webhook urls", 32));

export function encryptUrl(url: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_LENGTH });
  const data = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

/** The URL, or null when it can't be read (JWT_SECRET changed since). */
export function decryptUrl(stored: string): string | null {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  const authTag = Buffer.from(tag, "base64");
  // The whole tag, always: a shorter one would be easier to forge.
  if (authTag.length !== TAG_LENGTH) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Why a webhook URL can't be used, or null. */
export function webhookUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL.";
  }
  if (parsed.protocol !== "https:") return "A webhook URL starts with https://.";
  if (parsed.username || parsed.password) return "A webhook URL has no user name or password in it.";
  if (!backendAllowed(url, config.notifications.webhookHosts)) {
    return `Webhooks may only go to ${config.notifications.webhookHosts.join(", ")} (the install's notifications.webhookHosts).`;
  }
  return null;
}

// --- making events ---

export interface NewEvent {
  key: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  /** Who sees it in the console. */
  userIds: string[];
  /** Whose webhooks it's posted to, when they want this kind. */
  teams: string[];
}

/** Makes an event, unless it was made already; returns whether it was new. */
export async function notify(event: NewEvent): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [made] = await tx
      .insert(notificationEvents)
      .values({ key: event.key, kind: event.kind, title: event.title.slice(0, 300), body: (event.body ?? "").slice(0, 2000), link: event.link ?? null })
      .onConflictDoNothing({ target: notificationEvents.key })
      .returning({ id: notificationEvents.id });
    if (!made) return false;
    const userIds = [...new Set(event.userIds)];
    if (userIds.length > 0) {
      await tx.insert(userNotifications).values(userIds.map((userId) => ({ eventId: made.id, userId }))).onConflictDoNothing();
    }
    if (event.teams.length > 0) {
      const hooked = await tx
        .select({ teamId: teamWebhooks.teamId })
        .from(teamWebhooks)
        .innerJoin(teams, eq(teams.id, teamWebhooks.teamId))
        .where(and(inArray(teams.name, [...new Set(event.teams)]), sql`${event.kind} = any(${teamWebhooks.kinds})`));
      if (hooked.length > 0) {
        await tx.insert(webhookDeliveries).values(hooked.map((h) => ({ eventId: made.id, teamId: h.teamId }))).onConflictDoNothing();
      }
    }
    return true;
  });
}

/** People who'd want it, of these: not bots, which read no inbox. */
async function people(ids: (string | null)[]): Promise<string[]> {
  const wanted = ids.filter((id): id is string => id !== null);
  if (wanted.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, wanted), eq(users.isBot, false)));
  return rows.map((r) => r.id);
}

export interface FinishedRun {
  executionId: string;
  name: string;
  state: string;
  submittedBy: string | null;
  /** The teams it was for: a template run's team (or none), a DAG's teams. */
  teams: string[];
  /** When it finished, as the kernel says. */
  finishedAt: string | null;
  /** The step that failed, and why, if one did. */
  failedStep?: { taskId: string; code: string } | undefined;
}

/** A run that just finished (resourceRecorder.ts calls this as it records one). */
export async function runFinished(run: FinishedRun): Promise<void> {
  if (run.state !== "FAILED" && run.state !== "SUCCEEDED") return;
  const at = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!Number.isFinite(at) || Date.now() - at > NEWS_MS) return;
  const failed = run.state === "FAILED";
  await notify({
    key: `run:${run.executionId}:${run.state}:${run.finishedAt ?? ""}`,
    kind: failed ? "run_failed" : "run_succeeded",
    title: failed ? `${run.name} failed` : `${run.name} finished`,
    body: failed && run.failedStep ? `Step ${run.failedStep.taskId} failed: ${run.failedStep.code}.` : "",
    link: `/runs/${run.executionId}`,
    userIds: await people([run.submittedBy]),
    teams: failed ? run.teams : [],
  });
}

/** Steps waiting for an approval: their teams' maintainers, and webhooks. */
export async function notifyApprovals(): Promise<number> {
  const all = await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(isNull(teams.deletedAt), isNull(teams.retiredAt)));
  const waiting = await listAwaitingApproval(all.map((t) => t.name));
  let made = 0;
  for (const step of waiting) {
    const team = all.find((t) => t.name === step.team);
    if (!team) continue;
    const maintainers = await db
      .select({ id: teamMemberships.userId })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, team.id), eq(teamMemberships.role, "maintainer")));
    const requester = step.requestedBy.startsWith("user:") ? step.requestedBy.slice(5) : "";
    const fresh = await notify({
      key: `approval:${step.executionId}:${step.taskId}:${step.awaitingSince ?? ""}`,
      kind: "approval_waiting",
      title: `${step.executionName}: ${step.taskId} needs ${team.name}'s approval`,
      body: `It runs ${step.action} and waits until a maintainer of ${team.name} approves or declines it.`,
      link: `/runs/${step.executionId}`,
      userIds: await people(maintainers.map((m) => m.id).filter((id) => id !== requester)),
      teams: [team.name],
    });
    if (fresh) made += 1;
  }
  return made;
}

/** The catalog not pulled for a while: admins, once per outage. */
export async function notifyCatalog(): Promise<boolean> {
  const [status] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
  if (!status?.error || !status.checkedAt) return false;
  const since = status.appliedAt ?? status.checkedAt;
  if (Date.now() - since.getTime() < CATALOG_GRACE_MS) return false;
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), eq(users.isBot, false)));
  return notify({
    key: `catalog:${status.appliedAt?.toISOString() ?? "never"}`,
    kind: "catalog_failing",
    title: "The catalog isn't being pulled",
    body: status.error.slice(0, 500),
    link: "/admin",
    userIds: admins.map((a) => a.id),
    teams: [],
  });
}

// --- posting to webhooks ---

/** Posts one message; throws why it couldn't. */
export async function postToWebhook(url: string, text: string): Promise<void> {
  const problem = webhookUrlProblem(url);
  if (problem) throw new Error(problem);
  // {"text": ...} is what Slack's, Google Chat's and Teams' incoming webhooks all take.
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`The webhook answered ${String(response.status)}.`);
}

function message(event: { title: string; body: string; link: string | null }): string {
  const link = event.link && config.consoleUrl ? `\n${config.consoleUrl}${event.link}` : "";
  return `${event.title}${event.body ? `\n${event.body}` : ""}${link}`;
}

/** Posts what's waiting to be posted, oldest first. */
export async function deliverWebhooks(log: FastifyBaseLogger): Promise<number> {
  const pending = await db
    .select({
      eventId: webhookDeliveries.eventId,
      teamId: webhookDeliveries.teamId,
      attempts: webhookDeliveries.attempts,
      title: notificationEvents.title,
      body: notificationEvents.body,
      link: notificationEvents.link,
      urlEncrypted: teamWebhooks.urlEncrypted,
    })
    .from(webhookDeliveries)
    .innerJoin(notificationEvents, eq(notificationEvents.id, webhookDeliveries.eventId))
    .innerJoin(teamWebhooks, eq(teamWebhooks.teamId, webhookDeliveries.teamId))
    .where(and(isNull(webhookDeliveries.sentAt), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(notificationEvents.createdAt))
    .limit(50);
  let sent = 0;
  for (const d of pending) {
    const where = and(eq(webhookDeliveries.eventId, d.eventId), eq(webhookDeliveries.teamId, d.teamId));
    try {
      const url = decryptUrl(d.urlEncrypted);
      if (!url) throw new Error("The stored webhook URL can't be read (the console's key changed): set it again.");
      await postToWebhook(url, message(d));
      await db.update(webhookDeliveries).set({ sentAt: sql`now()`, attempts: d.attempts + 1 }).where(where);
      await db.update(teamWebhooks).set({ lastSentAt: sql`now()`, lastError: null }).where(eq(teamWebhooks.teamId, d.teamId));
      sent += 1;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await db.update(webhookDeliveries).set({ attempts: d.attempts + 1 }).where(where);
      await db.update(teamWebhooks).set({ lastError: why.slice(0, 500) }).where(eq(teamWebhooks.teamId, d.teamId));
      log.warn({ event: "webhook_failed", teamId: d.teamId, err: why }, "couldn't post to a team's webhook");
    }
  }
  return sent;
}

export function startNotifier(log: FastifyBaseLogger): void {
  let running = false;
  const pass = async () => {
    await notifyApprovals();
    await notifyCatalog();
    await deliverWebhooks(log);
  };
  const run = () => {
    if (running) return;
    running = true;
    pass()
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't look for what to notify");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
