// SPDX-License-Identifier: MIT
/**
 * Who ran what (ObserveService.GetUsage; Observe's Usage tab and the Teams
 * page): runs started for each team over a period, who started them, the
 * products their steps used, and the teams each team's products ran for.
 * From the console's own record of runs (submitted_executions), so it needs
 * no Prometheus; perf/README.md's phase 3 measured it at about 50 ms over
 * 200,000 runs. How runs ended is the kernel's, on Metrics.
 *
 * A run counts for the teams it was run for, as runView.ts decides who owns
 * it: a template run's onBehalfOf ("" when for no team), a raw DAG's every
 * team. Readiness checks (the console's own) don't count. Steps are the
 * steps of the DAG as submitted, retries not counted.
 *
 * Every install's whole usage is read once a minute per period, and each
 * caller is shown their part of it: an admin every team; anyone else the
 * teams they're in, the products those teams own (and every team that used
 * them, as each such run is already theirs to see in part), and the
 * products their teams used.
 */
import { Code } from "@connectrpc/connect";
import { sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { listRunnableProducts } from "../db/queries.js";
import { imageRepository } from "../imageRef.js";
import { CHECK_RUN } from "../readiness.js";

export const USAGE_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 3_600_000;
const CACHE_MS = 60_000;

export interface UsageCount {
  name: string;
  count: number;
}

export interface TeamUsage {
  /** "" for runs started for no team. */
  team: string;
  runs: number;
  /** Runs in the period before this one, as long. */
  previousRuns: number;
  byPeople: number;
  byBots: number;
  bySchedules: number;
  steps: number;
  /** Steps of its runs by product, most first. */
  used: UsageCount[];
  /** Steps of its own products by the team each run was for, most first. */
  ranFor: UsageCount[];
}

export interface ProductUsage {
  /** The registered product, or the image repository for one that isn't. */
  product: string;
  /** The product's team; for an image that isn't a product, the namespace its steps ran in. */
  team: string;
  action: string;
  registered: boolean;
  steps: number;
  runs: number;
  /** Steps by the team each run was for, most first. */
  usedBy: UsageCount[];
  lastUsed: Date;
}

interface Whole {
  since: Date;
  teams: Omit<TeamUsage, "used" | "ranFor">[];
  /** One per (team the run was for, product), with the product's team. */
  uses: { owner: string; key: string; product: string; repository: string; productTeam: string; action: string; registered: boolean; hidden: boolean; steps: number; runs: number; last: Date }[];
}

const cache = new Map<number, { at: number; whole: Promise<Whole> }>();

/** Each run in the window with the teams it counts for. */
function runs(since: Date, until: Date | null) {
  return sql`SELECT e.execution_id, e.payload, e.schedule_id, e.created_at, u.is_bot,
      CASE WHEN e.template IS NOT NULL THEN ARRAY[coalesce(e.on_behalf_of, '')] ELSE e.teams END AS owners
    FROM submitted_executions e LEFT JOIN users u ON u.id = e.submitted_by
    WHERE e.created_at >= ${since.toISOString()}::timestamptz
      ${until ? sql`AND e.created_at < ${until.toISOString()}::timestamptz` : sql``}
      AND e.template IS DISTINCT FROM ${CHECK_RUN}`;
}

async function readWhole(days: number): Promise<Whole> {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const before = new Date(now - 2 * days * DAY_MS);
  const counts = await db.execute<{ owner: string; runs: number; previous: number; schedules: number; bots: number; steps: number }>(sql`
    WITH r AS (${runs(before, null)})
    SELECT owner,
      count(*) FILTER (WHERE r.created_at >= ${since.toISOString()}::timestamptz)::int AS runs,
      count(*) FILTER (WHERE r.created_at < ${since.toISOString()}::timestamptz)::int AS previous,
      count(*) FILTER (WHERE r.created_at >= ${since.toISOString()}::timestamptz AND r.schedule_id IS NOT NULL)::int AS schedules,
      count(*) FILTER (WHERE r.created_at >= ${since.toISOString()}::timestamptz AND r.schedule_id IS NULL AND r.is_bot)::int AS bots,
      coalesce(sum(jsonb_array_length(r.payload->'tasks')) FILTER (
        WHERE r.created_at >= ${since.toISOString()}::timestamptz AND jsonb_typeof(r.payload->'tasks') = 'array'), 0)::int AS steps
    FROM r, unnest(r.owners) AS owner
    GROUP BY owner`);
  // By repository: the digest, then a tag, off (imageRef.ts finishes it).
  const steps = await db.execute<{ owner: string; image: string; action: string; team: string; steps: number; runs: number; last: string }>(sql`
    WITH r AS (${runs(since, null)})
    SELECT owner,
      regexp_replace(split_part(task->>'image', '@', 1), ':[^/:]*$', '') AS image,
      coalesce(task->>'action', '') AS action,
      coalesce(task->>'team', '') AS team,
      count(*)::int AS steps,
      count(DISTINCT r.execution_id)::int AS runs,
      max(r.created_at) AS last
    FROM r, unnest(r.owners) AS owner,
      jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'tasks') = 'array' THEN r.payload->'tasks' ELSE '[]'::jsonb END) AS task
    WHERE coalesce(task->>'image', '') <> ''
    GROUP BY 1, 2, 3, 4`);

  const products = await listRunnableProducts();
  const named = (repository: string, action: string) =>
    products.find((p) => p.action === action && imageRepository(p.image) === repository);
  const uses = new Map<string, Whole["uses"][number]>();
  for (const row of steps.rows) {
    const repository = imageRepository(row.image);
    const product = named(repository, row.action);
    const key = product ? `${product.teamName}/${product.name}/${row.action}` : `${row.team}/${repository}/${row.action}`;
    const last = new Date(row.last);
    const id = `${row.owner}\n${key}`;
    const seen = uses.get(id);
    if (seen) {
      seen.steps += row.steps;
      seen.runs += row.runs;
      if (last > seen.last) seen.last = last;
      continue;
    }
    uses.set(id, {
      owner: row.owner,
      key,
      product: product?.name ?? repository,
      repository,
      productTeam: product?.teamName ?? row.team,
      action: row.action,
      registered: product !== undefined,
      hidden: product?.hidden ?? false,
      steps: row.steps,
      runs: row.runs,
      last,
    });
  }
  return {
    since,
    teams: counts.rows.map((r) => ({
      team: r.owner,
      runs: r.runs,
      previousRuns: r.previous,
      byPeople: r.runs - r.schedules - r.bots,
      byBots: r.bots,
      bySchedules: r.schedules,
      steps: r.steps,
    })),
    uses: [...uses.values()],
  };
}

function whole(days: number): Promise<Whole> {
  const cached = cache.get(days);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.whole;
  const fresh = readWhole(days);
  cache.set(days, { at: Date.now(), whole: fresh });
  // A failed read isn't kept: the next caller tries again.
  fresh.catch(() => cache.delete(days));
  return fresh;
}

function tally(entries: [string, number][]): UsageCount[] {
  const sums = new Map<string, number>();
  for (const [name, n] of entries) sums.set(name, (sums.get(name) ?? 0) + n);
  return [...sums].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The caller's part of the last `days` days' usage. */
export async function getUsage(caller: AuthUser | undefined, days: number) {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  if (!(USAGE_DAYS as readonly number[]).includes(days)) {
    throw new ApiError(400, "BAD_REQUEST", `days is one of ${USAGE_DAYS.join(", ")}.`);
  }
  const { since, teams, uses } = await whole(days);
  const mine = new Set(caller.teamNames);
  const sees = (team: string) => caller.isAdmin || mine.has(team);
  // A hidden product's name only for its own team (and admins), as Metrics does.
  const shownName = (u: Whole["uses"][number]) => (u.hidden && !sees(u.productTeam) ? u.repository : u.product);

  const teamRows: TeamUsage[] = teams
    .filter((t) => sees(t.team) && (t.runs > 0 || t.previousRuns > 0))
    .map((t) => ({
      ...t,
      used: tally(uses.filter((u) => u.owner === t.team).map((u) => [shownName(u), u.steps])),
      ranFor: t.team === "" ? [] : tally(uses.filter((u) => u.registered && u.productTeam === t.team).map((u) => [u.owner, u.steps])),
    }))
    .sort((a, b) => b.runs - a.runs || a.team.localeCompare(b.team));

  const byProduct = new Map<string, ProductUsage>();
  for (const u of uses) {
    // Its own team's product (or a step in its namespace): every team that used it. Else only its teams' use.
    if (!sees(u.productTeam) && !sees(u.owner)) continue;
    const p = byProduct.get(u.key) ?? {
      product: shownName(u),
      team: u.productTeam,
      action: u.action,
      registered: u.registered,
      steps: 0,
      runs: 0,
      usedBy: [],
      lastUsed: u.last,
    };
    p.steps += u.steps;
    p.runs += u.runs;
    p.usedBy.push({ name: u.owner, count: u.steps });
    if (u.last > p.lastUsed) p.lastUsed = u.last;
    byProduct.set(u.key, p);
  }
  const productRows = [...byProduct.values()]
    .map((p) => ({ ...p, usedBy: tally(p.usedBy.map((x) => [x.name, x.count])) }))
    .sort((a, b) => b.steps - a.steps || a.product.localeCompare(b.product));

  return { since, days, teams: teamRows, products: productRows };
}

