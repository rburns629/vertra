// SPDX-License-Identifier: MIT
/**
 * The install's alerts, as a Prometheus has them now (Observe's Metrics):
 * the charts' alerting rules (their groups are vertra-console and
 * vertra-kernel), each inactive, pending or firing, with what it fires
 * for. Read from config.monitoring.prometheusUrl's HTTP API, which any
 * Prometheus serves itself, Alertmanager or not: the bundled one, one the
 * operator runs, or one outside the cluster.
 *
 * Every signed-in person sees them, as they see the Metrics tab; a firing
 * instance labelled with an API the caller can't see (another team's
 * hidden one) is counted, not described.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { listLiveTeamApis } from "../db/queries.js";
import { sees } from "./apis.js";

/** Prometheus's /api/v1/rules, as far as it's read here. */
interface RulesResponse {
  status: string;
  data?: {
    groups?: {
      name: string;
      rules?: {
        type: string;
        name: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        alerts?: { labels?: Record<string, string>; annotations?: Record<string, string>; state: string; activeAt?: string }[];
      }[];
    }[];
  };
}

export interface AlertInstanceView {
  state: string;
  activeAt: Date | null;
  summary: string;
  description: string;
  labels: Record<string, string>;
}

export interface AlertRuleView {
  name: string;
  severity: string;
  summary: string;
  state: string;
  instances: AlertInstanceView[];
  hidden: number;
}

/** The charts' rule groups. */
const OURS = /^vertra-/;
/** A rule's summary for no one instance: its template expressions left out. */
const general = (text: string) => text.replace(/\{\{[^}]*\}\}/g, "…");
const STATE_ORDER = ["firing", "pending", "inactive"];

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

export async function listAlerts(caller: AuthUser | undefined): Promise<{
  configured: boolean;
  problem: string;
  checkedAt: Date | null;
  rules: AlertRuleView[];
}> {
  const who = signedIn(caller);
  const base = config.monitoring.prometheusUrl;
  if (!base) return { configured: false, problem: "", checkedAt: null, rules: [] };
  const checkedAt = new Date();
  let body: RulesResponse;
  try {
    // Under the URL's own path, for a Prometheus served below one (https://host/prometheus).
    const response = await fetch(`${base}/api/v1/rules?type=alert`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { configured: true, problem: `Prometheus answered ${String(response.status)}.`, checkedAt, rules: [] };
    body = (await response.json()) as RulesResponse;
  } catch {
    return { configured: true, problem: "Prometheus isn't answering.", checkedAt, rules: [] };
  }
  if (body.status !== "success") return { configured: true, problem: "Prometheus couldn't list its rules.", checkedAt, rules: [] };

  // The APIs the caller may see, for instances labelled with one.
  const visible = who.isAdmin ? null : new Set((await listLiveTeamApis()).filter((a) => sees(who, a)).map((a) => `${a.teamName}/${a.name}`));
  const rules: AlertRuleView[] = [];
  for (const group of body.data?.groups ?? []) {
    if (!OURS.test(group.name)) continue;
    for (const rule of group.rules ?? []) {
      if (rule.type !== "alerting") continue;
      const active = (rule.alerts ?? []).filter((a) => a.state === "firing" || a.state === "pending");
      const shown = active.filter((a) => !visible || !a.labels?.["api"] || visible.has(a.labels["api"]));
      rules.push({
        name: rule.name,
        severity: rule.labels?.["severity"] ?? "",
        summary: general(rule.annotations?.["summary"] ?? ""),
        state: active.some((a) => a.state === "firing") ? "firing" : active.length > 0 ? "pending" : "inactive",
        instances: shown.map((a) => {
          const labels = Object.fromEntries(Object.entries(a.labels ?? {}).filter(([k]) => k !== "alertname" && k !== "severity"));
          return {
            state: a.state,
            activeAt: a.activeAt ? new Date(a.activeAt) : null,
            summary: a.annotations?.["summary"] ?? "",
            description: a.annotations?.["description"] ?? "",
            labels,
          };
        }),
        hidden: active.length - shown.length,
      });
    }
  }
  // Firing first, then pending; the rest as Prometheus lists them.
  rules.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  return { configured: true, problem: "", checkedAt, rules };
}
