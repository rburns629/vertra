// SPDX-License-Identifier: MIT
/**
 * Notifications (src/notifier.ts, src/core/notifications.ts): who's told
 * what, once; a team's webhook URL kept encrypted, only to allowed hosts,
 * never sent back, and set only by its maintainers; posting, and what a
 * failed post leaves. kernel-api and fetch are stubbed; the rest is the
 * real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { notificationEvents, teams, teamWebhooks, userNotifications, users as usersTable, webhookDeliveries } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { listAwaitingApproval } from "../src/kernel/client.js";
import { decryptUrl, deliverWebhooks, encryptUrl, notifyApprovals, runFinished, webhookUrlProblem } from "../src/notifier.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  listAwaitingApproval: vi.fn(() => Promise.resolve([])),
}));

const prefix = `ntf-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-team`;
const SLACK = "https://hooks.slack.com/services/T000/B000/s3cr3tpart";

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainer: { id: string; email: string };
let member: { id: string; email: string };
let maintainerToken: string;
let memberToken: string;
let teamId: string;
const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof deliverWebhooks>[0];

const inbox = async (userId: string) =>
  db
    .select({ title: notificationEvents.title, key: notificationEvents.key })
    .from(userNotifications)
    .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
    .where(eq(userNotifications.userId, userId));

beforeAll(async () => {
  app = await buildApp();
  teamId = (await createTeam(team)).id;
  maintainer = await users.makeUser();
  member = await users.makeUser();
  await addTeamMember(maintainer.id, teamId, "maintainer");
  await addTeamMember(member.id, teamId, "member");
  [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.delete(notificationEvents).where(like(notificationEvents.key, `%${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("a webhook URL", () => {
  it("is kept encrypted, and can't be read once changed", () => {
    const stored = encryptUrl(SLACK);
    expect(stored).not.toContain("s3cr3t");
    expect(decryptUrl(stored)).toBe(SLACK);
    const [v, iv, tag, data] = stored.split(".");
    expect(decryptUrl([v, iv, tag, `A${data?.slice(1) ?? ""}`].join("."))).toBeNull();
  });

  it("goes only to an allowed chat host, over https", () => {
    expect(webhookUrlProblem(SLACK)).toBeNull();
    expect(webhookUrlProblem("https://acme.webhook.office.com/webhookb2/x")).toBeNull();
    expect(webhookUrlProblem("http://hooks.slack.com/services/x")).toMatch(/https/);
    expect(webhookUrlProblem("https://kernel-api.vertra-system.svc/x")).toMatch(/only go to/);
    expect(webhookUrlProblem("https://hooks.slack.com.evil.example/x")).toMatch(/only go to/);
    expect(webhookUrlProblem("https://u:p@hooks.slack.com/x")).toMatch(/user name/);
  });
});

describe("a team's webhook", () => {
  it("is set by a maintainer, never sent back, and seen by members by its host", async () => {
    expect((await call(memberToken, "NotificationService/SetTeamWebhook", { team, url: SLACK, kinds: ["run_failed"] })).code).toBe("permission_denied");
    const refused = await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, url: "https://example.com/hook", kinds: ["run_failed"] });
    expect(refused.failure).toBe("WEBHOOK_URL");
    const set = await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, url: SLACK, kinds: ["run_failed", "approval_waiting"] });
    expect(set.code).toBe("ok");
    const seen = await call(memberToken, "NotificationService/GetTeamWebhook", { team });
    expect(seen.body).toMatchObject({ webhook: { configured: true, host: "hooks.slack.com", kinds: ["run_failed", "approval_waiting"] } });
    expect(JSON.stringify([set.body, seen.body])).not.toContain("s3cr3t");
    const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(row?.urlEncrypted).not.toContain("s3cr3t");
    // Changing only the kinds keeps the URL.
    await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_failed", "approval_waiting"] });
    const [kept] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(decryptUrl(kept?.urlEncrypted ?? "")).toBe(SLACK);
    expect((await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_succeeded"] })).code).toBe("invalid_argument");
  });
});

describe("a finished run", () => {
  it("tells whoever ran it once, and posts a failure to its team's webhook", async () => {
    const executionId = randomUUID();
    const run = { executionId, name: `${prefix} deploy`, state: "FAILED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString(), failedStep: { taskId: "deploy", code: "QUOTA" } };
    await runFinished(run);
    await runFinished(run);
    expect((await inbox(member.id)).filter((n) => n.key.includes(executionId)).map((n) => n.title)).toEqual([`${prefix} deploy failed`]);
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${executionId}%`));
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toHaveLength(1);

    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: { body: string; redirect: string }) => {
      posted.push({ url, body: JSON.parse(init.body) as unknown, redirect: init.redirect });
      return Promise.resolve(new Response("ok"));
    }));
    expect(await deliverWebhooks(silent)).toBeGreaterThanOrEqual(1);
    expect(posted).toContainEqual({ url: SLACK, body: { text: expect.stringContaining(`${prefix} deploy failed`) as unknown }, redirect: "error" });
    // Posted once.
    posted.length = 0;
    await deliverWebhooks(silent);
    expect(posted).toEqual([]);
  });

  it("isn't news when it finished long ago, and a success isn't posted", async () => {
    const old = randomUUID();
    await runFinished({ executionId: old, name: "old", state: "SUCCEEDED", submittedBy: member.id, teams: [team], finishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${old}%`))).toEqual([]);
    const ok = randomUUID();
    await runFinished({ executionId: ok, name: `${prefix} ok`, state: "SUCCEEDED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString() });
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${ok}%`));
    expect(event?.title).toBe(`${prefix} ok finished`);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toEqual([]);
  });

  it("leaves a failed post to be tried again, and says why", async () => {
    await runFinished({ executionId: randomUUID(), name: `${prefix} again`, state: "FAILED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("no", { status: 404 }))));
    await deliverWebhooks(silent);
    const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(row?.lastError).toBe("The webhook answered 404.");
    expect((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.teamId, teamId))).some((d) => d.sentAt === null && d.attempts === 1)).toBe(true);
  });
});

describe("a step waiting for an approval", () => {
  it("tells its team's maintainers, but not whoever ran it", async () => {
    const executionId = randomUUID();
    const bot = await users.makeUser();
    await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, bot.id));
    await addTeamMember(bot.id, teamId, "maintainer");
    vi.mocked(listAwaitingApproval).mockResolvedValue([
      { executionId, executionName: `${prefix} prod`, taskId: "deploy", team, image: "i", action: "create", requestedBy: `user:${maintainer.id}`, awaitingSince: new Date().toISOString() },
    ]);
    const other = await users.makeUser();
    await addTeamMember(other.id, teamId, "maintainer");
    await notifyApprovals();
    await notifyApprovals();
    const told = await db
      .select({ userId: userNotifications.userId })
      .from(userNotifications)
      .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
      .where(like(notificationEvents.key, `approval:${executionId}%`));
    expect(told.map((t) => t.userId)).toEqual([other.id]);
  });
});

describe("the inbox", () => {
  it("lists your own, counts what's unread, and marks it read", async () => {
    const listed = await call<{ notifications?: { id: string; read: boolean }[]; unreadCount?: number }>(memberToken, "NotificationService/ListNotifications");
    expect(listed.body.unreadCount).toBeGreaterThanOrEqual(2);
    const first = listed.body.notifications?.[0]?.id ?? "";
    await call(memberToken, "NotificationService/MarkNotificationsRead", { ids: [first] });
    // Someone else's can't be marked: nothing happens.
    await call(maintainerToken, "NotificationService/MarkNotificationsRead", { all: true });
    const after = await call<{ unreadCount?: number }>(memberToken, "NotificationService/ListNotifications");
    expect(after.body.unreadCount).toBe((listed.body.unreadCount ?? 0) - 1);
    await call(memberToken, "NotificationService/MarkNotificationsRead", { all: true });
    expect((await call<{ unreadCount?: number }>(memberToken, "NotificationService/ListNotifications")).body.unreadCount ?? 0).toBe(0);
    expect(await inbox(member.id)).not.toHaveLength(0);
    expect(await db.select().from(userNotifications).where(inArray(userNotifications.userId, [member.id]))).not.toHaveLength(0);
  });
});
