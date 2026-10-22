// SPDX-License-Identifier: MIT
/**
 * Observe's security checks (ObserveService.GetSecurity), for everyone
 * signed in: what this install enforces and what it doesn't yet, what it
 * refused over the last week (steps the cluster wouldn't start, and the
 * catalog's release when it couldn't be applied), and every image that may
 * run here with its scan. A refusal links its run only for those who may
 * see that run; a hidden product's image only for its own team.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { canActForTeam } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { catalogStatus } from "../catalogSync.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { findSubmittedExecutions, listRunnableProducts } from "../db/queries.js";
import { imageScans } from "../db/schema.js";
import { readImagePolicy } from "../imagePolicy.js";
import { listRefusals } from "../kernel/client.js";

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

const WEEK_MS = 7 * 24 * 3_600_000;

/** What each refusal code means, for the person reading the list. */
const WHY: Record<string, string> = {
  DISPATCH_REJECTED: "Its namespace isn't a team's.",
  IMAGE_NOT_ALLOWED: "Its image isn't from a source this install allows.",
  IMAGE_NOT_PINNED: "Its image wasn't pinned to a digest.",
  IMAGE_SCAN_FAILED: "Its image failed the security scan.",
  IMAGE_NOT_SIGNED: "Its image isn't signed by the catalog's CI.",
  IDENTITY_NOT_ALLOWED: "It asked for an identity or secrets its product isn't registered for.",
};

type Check = { name: string; state: "enforced" | "off" | "not_yet"; text: string };

/** What this install enforces, from its own settings, and the known gaps. */
async function checks(): Promise<Check[]> {
  const policy = await readImagePolicy().catch(() => null);
  const sources = policy?.exists ? [policy.source, ...policy.additional].filter(Boolean) : [];
  const { publicKeys, keylessIssuer } = config.catalog.signature;
  const list: Check[] = [
    {
      name: "Steps run only in team namespaces",
      state: "enforced",
      text: "An admission policy refuses a step's Job anywhere else, the platform's own namespace included (DISPATCH_REJECTED).",
    },
    {
      name: "Images only from allowed sources",
      state: policy?.exists ? "enforced" : "off",
      text: sources.length ? `The cluster runs a step's image only under ${sources.join(", ")} (IMAGE_NOT_ALLOWED).` : "No image policy is installed.",
    },
    {
      name: "Images pinned and scanned before they run",
      state: config.scanning.enabled ? "enforced" : "off",
      text: config.scanning.enabled
        ? `Every image is pinned to its digest and scanned before it's registered or run; a fixable high or critical vulnerability or a secret fails it. Images in use are rescanned every ${String(config.scanning.rescanHours)} hours.`
        : "Scanning is off on this install.",
    },
    {
      name: "Each step runs as its product's identity, with its team's secrets only",
      state: config.identityPolicyName ? "enforced" : "off",
      text: "An admission policy refuses a step that asks for a ServiceAccount or Secret its product isn't registered for (IDENTITY_NOT_ALLOWED).",
    },
    {
      name: "Teams' namespaces refuse traffic from other namespaces",
      state: config.teamNamespaces.defaultDenyIngress ? "enforced" : "off",
      text: "Each team namespace has a default-deny NetworkPolicy, so another team's steps can't reach its Pods.",
    },
    {
      name: "Catalog releases verified before they're applied",
      state: publicKeys.length > 0 || keylessIssuer ? "enforced" : "off",
      text:
        publicKeys.length > 0 || keylessIssuer
          ? "A release is applied only if a trusted signer signed it."
          : "Releases aren't verified: the registry's write access is the only trust.",
    },
    {
      name: "API products forward only what their reviewed specs describe",
      state: config.gateway.url ? "enforced" : "off",
      text: config.gateway.url
        ? `The gateway blocks any request its API's OpenAPI file doesn't describe, and forwards only to ${config.gateway.backendHosts.join(", ") || "no host yet"}.`
        : "The gateway isn't running on this install.",
    },
    {
      name: "The console's Secret writes fenced per team",
      state: "not_yet",
      text: "The console can still create and replace Secrets in any team namespace (it can't read them).",
    },
    {
      name: "Single sign-on",
      state: "not_yet",
      text: "Sign-in is by password; SSO with groups mapped to teams is planned.",
    },
    {
      name: "A write-once audit log",
      state: "not_yet",
      text: "The audit log lives in the console's own database; ship its log lines to a SIEM for now.",
    },
  ];
  return list;
}

function mayCount(n: unknown): number {
  return typeof n === "number" ? n : 0;
}

export async function getSecurity(caller: AuthUser | undefined) {
  const who = signedIn(caller);
  const since = new Date(Date.now() - WEEK_MS);

  const refused = await listRefusals(since);
  const runs = new Map((await findSubmittedExecutions([...new Set(refused.map((r) => r.executionId))])).map((e) => [e.executionId, e]));
  const refusals = refused.map((r) => {
    const run = runs.get(r.executionId);
    const visible =
      run !== undefined &&
      (who.isAdmin || run.submittedBy === who.id || run.teams.some((team) => canActForTeam(who, team)));
    return { at: r.at ? new Date(r.at) : null, what: `${r.team} step ${r.taskId} (${r.image})`, team: r.team, code: r.code, why: WHY[r.code] ?? r.message, executionId: visible ? r.executionId : "" };
  });
  const catalog = await catalogStatus();
  if (catalog.release && catalog.error && catalog.checkedAt && catalog.checkedAt >= since) {
    refusals.unshift({ at: catalog.checkedAt, what: "The catalog's release", team: "", code: "CATALOG_NOT_APPLIED", why: catalog.error, executionId: "" });
  }

  const scans = new Map((await db.select().from(imageScans)).map((s) => [s.digest, s]));
  const images = (await listRunnableProducts())
    .filter((p) => !p.hidden || who.isAdmin || who.teamNames.includes(p.teamName))
    .map((p) => {
      const digest = /@(sha256:[0-9a-f]{64})/.exec(p.image)?.[1] ?? "";
      const scan = digest ? scans.get(digest) : undefined;
      const findings = (scan?.findings ?? {}) as { fixable?: unknown; unfixable?: unknown; secrets?: unknown };
      return {
        product: p.name,
        team: p.teamName,
        image: p.image,
        scan: scan?.status ?? "unscanned",
        scannedAt: scan?.scannedAt ?? null,
        fixable: mayCount(findings.fixable),
        unfixable: mayCount(findings.unfixable),
        secrets: mayCount(findings.secrets),
        acceptedReason: scan?.acceptedReason ?? "",
      };
    })
    .sort((a, b) => `${a.team}/${a.product}`.localeCompare(`${b.team}/${b.product}`));

  return { checks: await checks(), refusals, images };
}
