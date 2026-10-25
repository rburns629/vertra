// SPDX-License-Identifier: MIT
/**
 * Single sign-on's settings in effect, and its groups.
 *
 * The provider is the install's (config.oidc, from the console chart's sso)
 * when it set one; else the one admins saved (sso_settings, its secret
 * sealed), when it's on. Every console reads the saved one every few
 * seconds, so a change reaches them all without a restart; currentSso() is
 * synchronous for the many places that only ask whether it's on.
 *
 * Groups come from the ID token's groups claim and/or Google Workspace
 * (Cloud Identity's Groups API, as this console's own Google identity,
 * asking about each mapped Google group). At
 * each sign-in, every team a group is mapped to follows them for that
 * person: added with the best role their groups give, changed, or removed.
 * A lookup that fails refuses the sign-in rather than counting as no
 * groups, which would take people out of their teams.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { ssoGroupMappings, ssoSettings, teamMemberships, teams, type TeamRole } from "./db/schema.js";
import { unseal } from "./sealed.js";

export const SECRET_PURPOSE = "sso client secret";
const REFRESH_MS = 10_000;
const CLOUD_IDENTITY = "https://cloudidentity.googleapis.com/v1/";
const METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_EMAIL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const GROUPS_SCOPE = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";

export interface Sso {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  allowedDomains: string[];
  label: string;
  setByInstall: boolean;
}

export interface GroupSources {
  /** The ID token claim listing a person's groups; "": none. */
  claim: string;
  google: boolean;
}

let saved: { provider: Sso | null; groups: GroupSources } = { provider: null, groups: { claim: "", google: false } };

/** The provider people may sign in with now, or null when single sign-on is off. */
export function currentSso(): Sso | null {
  return config.oidc ? { ...config.oidc, setByInstall: true } : saved.provider;
}

export function groupSources(): GroupSources {
  return saved.groups;
}

/** Reads the saved settings again: every few seconds, and after a save. */
export async function refreshSso(log?: FastifyBaseLogger): Promise<void> {
  const [row] = await db.select().from(ssoSettings).where(eq(ssoSettings.id, 1));
  const groups = { claim: row?.groupsClaim ?? "", google: row?.googleGroups ?? false };
  let provider: Sso | null = null;
  if (row?.enabled && row.issuer && row.clientId && row.redirectUrl && row.clientSecretEncrypted) {
    const clientSecret = unseal(row.clientSecretEncrypted, SECRET_PURPOSE);
    if (clientSecret === null) {
      log?.error({ event: "sso_secret_unreadable" }, "the single sign-on client secret can't be read (JWT_SECRET changed?): set it again on the Admin page");
    } else {
      provider = {
        issuer: row.issuer,
        clientId: row.clientId,
        clientSecret,
        redirectUrl: row.redirectUrl,
        allowedDomains: row.allowedDomains,
        label: row.label || "single sign-on",
        setByInstall: false,
      };
    }
  }
  saved = { provider, groups };
}

export function startSsoRefresh(log: FastifyBaseLogger): void {
  const timer = setInterval(() => {
    refreshSso(log).catch((error: unknown) => {
      log.error({ event: "sso_refresh_failed", err: error }, "couldn't read the single sign-on settings");
    });
  }, REFRESH_MS);
  timer.unref();
}

/** Why a person's groups couldn't be read: their sign-in is refused. */
export class GroupsUnavailable extends Error {}

/** This console's own Google access token, from the metadata server (GKE Workload Identity). */
async function googleToken(): Promise<string> {
  const url = new URL(METADATA_TOKEN);
  url.searchParams.set("scopes", GROUPS_SCOPE);
  const response = await fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`the metadata server answered ${String(response.status)}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

let identity: Promise<string> | undefined;

/** The Google account this console acts as (GKE Workload Identity), or "" off Google Cloud: asked once. */
export function googleIdentity(): Promise<string> {
  identity ??= fetch(METADATA_EMAIL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) })
    .then(async (response) => (response.ok ? (await response.text()).trim() : ""))
    .catch(() => "");
  return identity;
}

/**
 * Which of these Google groups (by email) the person is in, directly or
 * through another group. Asked group by group (checkTransitiveMembership),
 * which a Groups Reader may do; searching all of a person's groups at once
 * (searchTransitiveGroups) needs more than that role (found on GKE,
 * 2026-10-25). A group that doesn't exist has nobody in it.
 */
async function googleGroupsOf(email: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const token = await googleToken();
  // Joined as text: as a relative URL, "groups:lookup" would read as a scheme.
  const get = (path: string) => fetch(CLOUD_IDENTITY + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const query = `member_key_id == '${email.replace(/'/g, "")}'`;
  const found: string[] = [];
  for (const group of candidates) {
    const looked = await get(`groups:lookup?${new URLSearchParams({ "groupKey.id": group }).toString()}`);
    if (looked.status === 404) continue;
    if (!looked.ok) throw new Error(`Cloud Identity answered ${String(looked.status)} looking up ${group}: ${(await looked.text()).slice(0, 300)}`);
    const { name } = (await looked.json()) as { name: string };
    const checked = await get(`${name}/memberships:checkTransitiveMembership?${new URLSearchParams({ query }).toString()}`);
    if (!checked.ok) throw new Error(`Cloud Identity answered ${String(checked.status)} checking ${group}: ${(await checked.text()).slice(0, 300)}`);
    if (((await checked.json()) as { hasMembership?: boolean }).hasMembership === true) found.push(group);
  }
  return found;
}

/**
 * The person's groups, lowercased, or null when no source is set. A source
 * that's set but can't say (a missing claim, Entra ID's overage, Google's
 * API failing) throws GroupsUnavailable.
 */
export async function groupsOf(claims: Record<string, unknown>, email: string): Promise<string[] | null> {
  const sources = groupSources();
  if (!sources.claim && !sources.google) return null;
  const groups: string[] = [];
  if (sources.claim) {
    const value = claims[sources.claim];
    if (!Array.isArray(value)) {
      const overage = typeof claims["_claim_names"] === "object" && claims["_claim_names"] !== null;
      throw new GroupsUnavailable(
        overage
          ? `The provider left out the ${sources.claim} claim: too many groups to list (configure it to send only the groups assigned to Vertra).`
          : `The ID token has no ${sources.claim} claim: configure the provider to send it.`,
      );
    }
    groups.push(...value.filter((g): g is string => typeof g === "string"));
  }
  if (sources.google) {
    // Only the mapped groups that are Google groups (by email) matter.
    const mapped = await db.selectDistinct({ group: ssoGroupMappings.groupName }).from(ssoGroupMappings);
    try {
      groups.push(...(await googleGroupsOf(email, mapped.map((m) => m.group).filter((g) => g.includes("@")))));
    } catch (error) {
      throw new GroupsUnavailable(`Couldn't read Google Workspace groups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(groups.map((g) => g.toLowerCase()))];
}

const rank = (role: TeamRole) => (role === "maintainer" ? 2 : 1);

/**
 * Makes the person's membership of every mapped team follow their groups:
 * the best role a group of theirs is mapped to, or none. Teams nothing maps
 * to are left alone. Returns what changed.
 */
export async function syncMappedTeams(userId: string, groups: string[], log: FastifyBaseLogger): Promise<string[]> {
  const mappings = await db
    .select({ groupName: ssoGroupMappings.groupName, teamId: ssoGroupMappings.teamId, role: ssoGroupMappings.role, teamName: teams.name })
    .from(ssoGroupMappings)
    .innerJoin(teams, eq(teams.id, ssoGroupMappings.teamId));
  if (mappings.length === 0) return [];
  const mine = new Set(groups);
  const wanted = new Map<string, { name: string; role: TeamRole | null }>();
  for (const m of mappings) {
    const current = wanted.get(m.teamId) ?? { name: m.teamName, role: null };
    if (mine.has(m.groupName.toLowerCase()) && (current.role === null || rank(m.role) > rank(current.role))) current.role = m.role;
    wanted.set(m.teamId, current);
  }
  const held = new Map(
    (
      await db
        .select({ teamId: teamMemberships.teamId, role: teamMemberships.role })
        .from(teamMemberships)
        .where(and(eq(teamMemberships.userId, userId), inArray(teamMemberships.teamId, [...wanted.keys()])))
    ).map((m) => [m.teamId, m.role]),
  );
  const changes: string[] = [];
  for (const [teamId, { name, role }] of wanted) {
    const now = held.get(teamId);
    if (role === null && now) {
      await db.delete(teamMemberships).where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)));
      changes.push(`left ${name}`);
    } else if (role && !now) {
      await db.insert(teamMemberships).values({ userId, teamId, role }).onConflictDoNothing();
      changes.push(`joined ${name} as ${role}`);
    } else if (role && now !== role) {
      await db.update(teamMemberships).set({ role }).where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)));
      changes.push(`${role} of ${name}`);
    }
  }
  if (changes.length > 0) log.warn({ event: "sso_teams_synced", userId, changes }, "team memberships follow single sign-on groups");
  return changes;
}

/** Whether a team's memberships of single sign-on users follow groups (it has a mapping). */
export async function teamIsMapped(teamId: string): Promise<boolean> {
  const [row] = await db.select({ id: ssoGroupMappings.id }).from(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, teamId)).limit(1);
  return row !== undefined;
}
