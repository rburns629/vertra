// SPDX-License-Identifier: MIT
/**
 * Starting schedules (core/schedules.ts): every 30 seconds, each enabled
 * schedule whose time has come is claimed by moving its next run on, in
 * one conditional write (so two consoles never start it twice, and a
 * console that was down starts only the latest time it missed), then run
 * as its bot, for its team, as the bot running it itself would be, with a
 * request id per time so a retried start doesn't run it twice. A start
 * that's refused (the bot lost access, a parameter no longer fits) is kept
 * on the schedule and told to the team's maintainers.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { ApiError } from "./apiError.js";
import { callerForUser } from "./auth/plugin.js";
import { nextFor } from "./core/schedules.js";
import { runAction, runTemplate } from "./core/templates.js";
import { db } from "./db/client.js";
import { schedules, teamMemberships, teams, users } from "./db/schema.js";
import { config } from "./config.js";
import { recordNextSchedule } from "./k8s.js";
import { notify } from "./notifier.js";

type Schedule = typeof schedules.$inferSelect;

/** Claims a due schedule by moving its next run on; returns the time it was due, or null if another console got it. */
async function claim(schedule: Schedule): Promise<Date | null> {
  if (!schedule.nextRunAt) return null;
  let next: Date | null;
  try {
    next = nextFor(schedule.cron, schedule.timeZone);
  } catch {
    next = null;
  }
  const [claimed] = await db
    .update(schedules)
    .set({ nextRunAt: next })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.nextRunAt, schedule.nextRunAt)))
    .returning({ id: schedules.id });
  return claimed ? schedule.nextRunAt : null;
}

async function tellMaintainers(schedule: Schedule, team: string, due: Date, why: string): Promise<void> {
  const maintainers = await db
    .select({ id: teamMemberships.userId })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.teamId, schedule.teamId), eq(teamMemberships.role, "maintainer"), eq(users.isBot, false)));
  await notify({
    key: `schedule:${schedule.id}:${due.toISOString()}`,
    kind: "run_failed",
    title: `Schedule ${schedule.name} couldn't start`,
    body: why.slice(0, 500),
    link: `/teams/${team}?tab=schedules`,
    userIds: maintainers.map((m) => m.id),
    teams: [team],
  });
}

/** Starts one schedule's run, due at `due`. */
async function start(schedule: Schedule, team: string, due: Date, log: FastifyBaseLogger): Promise<void> {
  const request = { parameters: schedule.parameters, onBehalfOf: team, requestId: `schedule:${schedule.id}:${due.toISOString()}` };
  try {
    const bot = await callerForUser(schedule.botId);
    if (!bot) throw new ApiError(409, "BOT_GONE", "Its bot no longer exists.");
    const run =
      schedule.kind === "template"
        ? await runTemplate(bot, schedule.runnableTeam, schedule.runnableName, request, log, schedule.id)
        : await runAction(bot, schedule.runnableName, request, log, schedule.id);
    await db.update(schedules).set({ lastRunAt: due, lastExecutionId: run.executionId, lastError: null }).where(eq(schedules.id, schedule.id));
    log.info({ event: "schedule_started", scheduleId: schedule.id, executionId: run.executionId }, "started a scheduled run");
  } catch (error) {
    // Refused (an ApiError says why), or the platform didn't answer: this
    // time is missed either way, and the schedule says so.
    const why = error instanceof ApiError ? error.message : "Vertra couldn't start it: the platform didn't answer. The next time runs as usual.";
    await db.update(schedules).set({ lastRunAt: due, lastError: why.slice(0, 1000) }).where(eq(schedules.id, schedule.id));
    log.warn({ event: "schedule_refused", scheduleId: schedule.id, err: error }, "a scheduled run didn't start");
    await tellMaintainers(schedule, team, due, why);
  }
}

let nextRecorded: string | undefined;

/**
 * The earliest enabled schedule's next run, kept in the activity ConfigMap
 * for the kernel's sleeper: it stays awake for one due soon, and wakes a
 * sleeping install a little before one. Written only when it changes.
 */
async function publishNextSchedule(): Promise<void> {
  if (!config.activityConfigMap || !config.platformNamespace) return;
  const [row] = await db
    .select({ next: sql<Date | null>`min(${schedules.nextRunAt})` })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt)));
  const next = row?.next ? new Date(row.next) : null;
  const key = next?.toISOString() ?? "";
  if (key === nextRecorded) return;
  await recordNextSchedule(config.platformNamespace, config.activityConfigMap, next);
  nextRecorded = key;
}

/** One pass: every enabled schedule that's due. */
export async function startDueSchedules(log: FastifyBaseLogger): Promise<number> {
  const due = await db
    .select({ schedule: schedules, team: teams.name })
    .from(schedules)
    .innerJoin(teams, eq(teams.id, schedules.teamId))
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, sql`now()`)))
    .limit(50);
  let started = 0;
  for (const { schedule, team } of due) {
    const at = await claim(schedule);
    if (!at) continue;
    await start(schedule, team, at, log);
    started += 1;
  }
  await publishNextSchedule();
  return started;
}

export function startScheduleRunner(log: FastifyBaseLogger): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    startDueSchedules(log)
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't start due schedules");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
