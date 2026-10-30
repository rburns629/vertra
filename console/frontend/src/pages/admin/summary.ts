// SPDX-License-Identifier: MIT
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  getAdminChannel,
  getAuditCopy,
  getCatalogStatus,
  getChatConfig,
  getGateway,
  getImagePolicy,
  getInstall,
  getPolicySync,
  getSecurity,
  getSsoSettings,
  listAllTeams,
  listAutomationTokens,
  listImageScans,
  listSsoGroupMappings,
  listUsers,
  type AuditCopy,
  type AutomationToken,
  type CatalogStatus,
  type ChatConfig,
  type GatewayInfo,
  type ImagePolicy,
  type ImageScan,
  type InstallInfo,
  type PolicySync,
  type SecurityView,
  type SsoGroupMapping,
  type SsoSettings,
  type Team,
  type UserAccount,
} from "../../api";
import type { Tone } from "./parts";

/**
 * Everything the Admin page's states come from: each part as the API gives
 * it, or null when it couldn't be read (then that part shows no state,
 * rather than a guessed one).
 */
export interface AdminSummary {
  install: InstallInfo | null;
  people: UserAccount[] | null;
  teams: Team[] | null;
  sso: SsoSettings | null;
  mappings: SsoGroupMapping[] | null;
  tokens: AutomationToken[] | null;
  catalog: CatalogStatus | null;
  imagePolicy: ImagePolicy | null;
  scans: ImageScan[] | null;
  /** Observe's security view: its images are the ones registered products run now. */
  security: SecurityView | null;
  gateway: GatewayInfo | null;
  chat: ChatConfig | null;
  channel: string | null;
  policies: PolicySync[] | null;
  audit: AuditCopy | null;
}

/** A part's state in a few words, with its dot. */
export interface State {
  tone: Tone;
  text: string;
}

const value = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/**
 * A section changed something: the summary (the navigation's states, the
 * overview) is read again. AdminPage provides it; a card calls it after a
 * change of its own succeeds.
 */
export const AdminChanged = createContext<() => void>(() => {});
export const useAdminChanged = () => useContext(AdminChanged);

/** Reads every part at once (admins only: AdminPage calls it after its check), and again on `reload`. */
export function useAdminSummary(): { summary: AdminSummary | null; reload: () => void } {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      getInstall(),
      listUsers(),
      listAllTeams(),
      getSsoSettings(),
      listSsoGroupMappings(),
      listAutomationTokens(),
      getCatalogStatus(),
      getImagePolicy(),
      listImageScans(),
      getGateway(),
      getChatConfig(),
      getAdminChannel(),
      getPolicySync(),
      getAuditCopy(),
      getSecurity(),
    ]).then(([install, people, teams, sso, mappings, tokens, catalog, imagePolicy, scans, gateway, chat, channel, policies, audit, security]) => {
      if (!live) return;
      setSummary({
        install: value(install),
        people: value(people),
        teams: value(teams),
        sso: value(sso),
        mappings: value(mappings),
        tokens: value(tokens),
        catalog: value(catalog),
        imagePolicy: value(imagePolicy),
        scans: value(scans),
        gateway: value(gateway),
        chat: value(chat),
        channel: value(channel),
        policies: value(policies),
        audit: value(audit),
        security: value(security),
      });
    });
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => { setRound((n) => n + 1); }, []);
  return { summary, reload };
}

/** Tokens that still sign in: the list includes expired ones (only revoked ones are left out). */
export const workingTokens = <T extends { expiresAt: string | null }>(tokens: T[]): T[] =>
  tokens.filter((t) => !t.expiresAt || new Date(t.expiresAt).getTime() > Date.now());

/** A failed scan nobody accepted: the image can't run. */
export const blocksRun = (s: ImageScan) => s.status === "failed" && !s.acceptedReason;

/** A digest's hex, from a digest or an image reference that pins one. */
const hex = (ref: string) => (ref.split("@").at(-1) ?? ref).replace(/^sha256:/, "");

/**
 * The failed scans that need an admin: of images a registered product runs
 * now (Observe's images). An old build a product has moved on from fails
 * quietly, since nothing runs it; it stays in Image scans' list. When
 * Observe's images couldn't be read, every failed scan counts.
 */
export function failingInUse(s: AdminSummary): ImageScan[] {
  return inUse(s, (s.scans ?? []).filter(blocksRun));
}

/** Scans that couldn't run (an image that can't be submitted until one does), of images in use, the same way. */
export function unscannedInUse(s: AdminSummary): ImageScan[] {
  return inUse(s, (s.scans ?? []).filter((x) => x.status === "error"));
}

function inUse(s: AdminSummary, scans: ImageScan[]): ImageScan[] {
  if (!s.security) return scans;
  const used = new Set(s.security.images.map((i) => hex(i.image)));
  return scans.filter((f) => used.has(hex(f.digest)));
}

/** Teams that still exist (retired ones included). */
export const liveTeams = (teams: Team[]) => teams.filter((t) => !t.deletedAt);

/** The audit copy's state; also its card's pill. */
export function auditState(copy: AuditCopy): State {
  if (!copy.enabled) return { tone: "off", text: "Off" };
  if (copy.differsAt > 0) return { tone: "err", text: "Changed since copied" };
  if (copy.brokenAt > 0) return { tone: "err", text: "Chain broken" };
  if (copy.problem) return { tone: "warn", text: "Not copying" };
  // Intact only when it's been checked and compared: never as a default.
  if (copy.compareProblem) return { tone: "warn", text: "Not compared" };
  if (!copy.checkedAt) return { tone: "off", text: "Not checked yet" };
  return { tone: "ok", text: "Intact" };
}

/** The policies written since the console started, and how many of them failed. */
export function policiesState(policies: PolicySync[]): State {
  const applying = policies.filter((p) => p.applies);
  const failing = applying.filter((p) => !p.ok).length;
  if (failing > 0) return { tone: "err", text: `${String(failing)} not written` };
  if (applying.length === 0) return { tone: "off", text: "None yet" };
  return { tone: "ok", text: "In sync" };
}

/** The catalog: off, failing, applied with exceptions, or applied. */
export function catalogState(catalog: CatalogStatus): State {
  if (!catalog.release) return { tone: "off", text: "Off" };
  if (catalog.error) return { tone: "err", text: "Not applied" };
  const adopt = catalog.problems.filter((p) => p.adoptableTeam).length;
  if (adopt > 0) return { tone: "warn", text: `${String(adopt)} to adopt` };
  if (catalog.problems.length > 0) return { tone: "warn", text: `${String(catalog.problems.length)} not applied` };
  if (!catalog.appliedAt) return { tone: "warn", text: "Not yet" };
  return { tone: "ok", text: catalog.version || "Applied" };
}

/** The state each section's entry in the side navigation shows, where the API gives one. */
export function sectionStates(s: AdminSummary): Partial<Record<string, State>> {
  const states: Partial<Record<string, State>> = {};
  if (s.people) {
    const toFinish = s.people.filter((p) => p.mustChangePassword).length;
    states.people = toFinish > 0 ? { tone: "warn", text: `${String(toFinish)} to finish` } : { tone: "ok", text: String(s.people.length) };
  }
  if (s.sso) states["sign-in"] = s.sso.enabled ? { tone: "ok", text: s.sso.label || "On" } : { tone: "off", text: "Off" };
  if (s.tokens) {
    const working = workingTokens(s.tokens).length;
    states.tokens = working > 0 ? { tone: "ok", text: String(working) } : { tone: "off", text: "None" };
  }
  if (s.catalog) states.catalog = catalogState(s.catalog);
  if (s.imagePolicy) {
    states.images = !s.imagePolicy.exists
      ? { tone: "err", text: "No policy" }
      : s.imagePolicy.allowed.length === 0
        ? { tone: "err", text: "None" }
        : { tone: "ok", text: String(s.imagePolicy.allowed.length) };
  }
  if (s.install && !s.install.scanning) states.scans = { tone: "off", text: "Off" };
  else if (s.scans) {
    const failed = failingInUse(s).length;
    const unscanned = unscannedInUse(s).length;
    states.scans = failed > 0 ? { tone: "err", text: `${String(failed)} failed` } : unscanned > 0 ? { tone: "warn", text: `${String(unscanned)} not scanned` } : { tone: "ok", text: "Passing" };
  }
  if (s.gateway) states.gateway = !s.gateway.enabled ? { tone: "off", text: "Off" } : s.gateway.closedMessage ? { tone: "warn", text: "Closed" } : { tone: "ok", text: "Open" };
  if (s.chat) states.chat = s.chat.problem ? { tone: "err", text: "Not working" } : s.chat.enabled ? { tone: "ok", text: "On" } : { tone: "off", text: "Off" };
  // Admins always get them in the console (and by email); a team's chat too, when chosen.
  if (s.channel !== null) states.alerts = { tone: "ok", text: s.channel || "On" };
  if (s.policies) states.policies = policiesState(s.policies);
  if (s.audit) states.audit = auditState(s.audit);
  return states;
}
