// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Alert, Box, Chip, Link, Tab, Tabs, Typography } from "@mui/material";
import {
  ApiError,
  getTeam,
  listTeamMembers,
  listTeamPods,
  listTeamSecrets,
  purgeTeam,
  retireTeam,
  unretireTeam,
  type Team,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { Pill } from "../components/Pill";
import { useEnvironment } from "../environment";
import { AutomationTab } from "./team/AutomationTab";
import { SchedulesTab } from "./team/SchedulesTab";
import { TeamOffers } from "./team/TeamOffers";
import { MembersTab } from "./team/MembersTab";
import { ApisTab } from "./team/ApisTab";
import { RunningTab } from "./team/RunningTab";
import { SecretsTab } from "./team/SecretsTab";
import { SettingsTab } from "./team/SettingsTab";

type TabId = "members" | "offers" | "secrets" | "automation" | "schedules" | "apis" | "running" | "settings";
const TABS: [TabId, string][] = [
  ["members", "Members"],
  ["offers", "What it offers"],
  ["secrets", "Secrets"],
  ["automation", "Automation"],
  ["schedules", "Schedules"],
  ["apis", "APIs"],
  ["running", "Running now"],
  ["settings", "Settings"],
];

/** The small counts on the tabs. Display only: a failed count just isn't
 * shown, and each tab loads (and reports errors for) its own data. */
function useTabCounts(teamName: string, tab: TabId, enabled: boolean) {
  const [counts, setCounts] = useState<Partial<Record<TabId, number>>>({});
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.allSettled([listTeamMembers(teamName), listTeamSecrets(teamName), listTeamPods(teamName)]).then(
      ([members, secrets, pods]) => {
        if (cancelled) return;
        setCounts({
          members: members.status === "fulfilled" ? members.value.filter((m) => !m.isBot).length : undefined,
          secrets: secrets.status === "fulfilled" ? secrets.value.length : undefined,
          running:
            pods.status === "fulfilled"
              ? pods.value.filter((p) => p.state === "running" || p.state === "starting" || p.state === "cant-start").length
              : undefined,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [teamName, tab, enabled]);
  return counts;
}

export function TeamPage() {
  const { teamName = "" } = useParams();
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const sso = useEnvironment()?.ssoLabel ?? "";
  const isMember = user?.teamNames.includes(teamName) ?? false;
  const isAdmin = user?.isAdmin ?? false;
  // Platform admins can see and manage any team, not just ones they belong
  // to -- see ../../src/auth/access.ts's matching backend checks. Any
  // member sees the tabs; only a maintainer gets their forms. The API
  // refuses either way; this only decides what to show, so nobody sees a
  // 403 they can't act on.
  const canSee = isMember || isAdmin;
  const canMaintain = (user?.maintainerOf.includes(teamName) ?? false) || isAdmin;
  // The tab is in the address (?tab=settings), so it can be linked to.
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as TabId | null;
  const tabs = TABS.filter(([id]) => id !== "automation" || canMaintain); // bots are a maintainer's
  const tab: TabId = tabs.some(([id]) => id === requested) ? (requested as TabId) : "members";
  const setTab = (next: TabId) => { setParams(next === "members" ? {} : { tab: next }, { replace: true }); };
  const [team, setTeam] = useState<Team | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const retired = Boolean(team?.retiredAt);
  const counts = useTabCounts(teamName, tab, canSee);

  const reload = useCallback(() => {
    // Display only: if this fails, the page still works without the
    // retired marker, and the forms below surface their own errors.
    getTeam(teamName).then(setTeam).catch(() => undefined);
  }, [teamName]);

  useEffect(() => {
    setTeam(null);
    reload();
  }, [reload]);

  /** Retire, restore or purge: the refusal shown up top, the team reloaded after. */
  async function lifecycle(action: () => Promise<void>): Promise<void> {
    setLifecycleError(null);
    setLifecycleBusy(true);
    try {
      await action();
    } catch (err) {
      // A purge is refused (409) while runs are unfinished; its message says so.
      setLifecycleError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setLifecycleBusy(false);
    }
  }

  const role = isMember ? (canMaintain ? "You maintain it" : "You're a member") : isAdmin ? "Viewing as admin" : null;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/teams">
          Teams
        </Link>{" "}
        / {teamName}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mt: 0.75, mb: 0.5 }}>
        <Typography variant="h4" component="h1" sx={{ overflowWrap: "anywhere" }}>
          {teamName}
        </Typography>
        {retired && <Pill tone="neutral">Retired</Pill>}
        {role && <Pill tone="info">{role}</Pill>}
        {sso && team?.requireSso && (
          <Pill tone="neutral" title={`Members sign in with ${sso}; their passwords don't work (admins' do).`}>
            {sso} sign-in only
          </Pill>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Namespace <Box component="span" sx={{ fontFamily: "fontFamilyMono" }}>{teamName}</Box>
        {team && (team.fromCatalog ? " · from the catalog" : " · made here")}
      </Typography>

      {retired && (
        <Alert severity="info" sx={{ mb: 3 }}>
          This team is retired: it&apos;s read-only. Nothing new can be registered, granted or run for it, and its products
          are no longer listed. Its history stays visible.
          {isAdmin ? " Restore it from its Settings." : " An admin can restore it."}
        </Alert>
      )}
      {lifecycleError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {lifecycleError}
        </Alert>
      )}

      {!canSee ? (
        <TeamOffers teamName={teamName} showProfile />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(_event, value: TabId) => { setTab(value); }}
            variant="scrollable"
            allowScrollButtonsMobile
            sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
          >
            {tabs.map(([id, label]) => (
              <Tab
                key={id}
                value={id}
                label={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {label}
                    {counts[id] !== undefined && counts[id] > 0 && <Chip label={counts[id]} size="small" sx={{ height: 20, fontSize: 12 }} />}
                  </Box>
                }
              />
            ))}
          </Tabs>
          {tab === "members" && (
            <MembersTab
              teamName={teamName}
              readOnly={retired || !canMaintain}
              currentUserId={user?.id}
              onShowAutomation={canMaintain ? () => { setTab("automation"); } : undefined}
            />
          )}
          {tab === "offers" && <TeamOffers teamName={teamName} showProfile={false} />}
          {tab === "secrets" && <SecretsTab teamName={teamName} readOnly={retired || !canMaintain} />}
          {tab === "automation" && canMaintain && <AutomationTab teamName={teamName} readOnly={retired} />}
          {tab === "schedules" && <SchedulesTab teamName={teamName} readOnly={retired || !canMaintain} />}
          {tab === "apis" && <ApisTab teamName={teamName} />}
          {tab === "running" && <RunningTab teamName={teamName} />}
          {tab === "settings" && team && (
            <SettingsTab
              team={team}
              isAdmin={isAdmin}
              busy={lifecycleBusy}
              onChanged={reload}
              onRetire={() => lifecycle(async () => { await retireTeam(teamName); reload(); })}
              onRestore={() => lifecycle(async () => { await unretireTeam(teamName); reload(); })}
              onPurge={() =>
                lifecycle(async () => {
                  await purgeTeam(teamName);
                  // The teams list (and every team picker) reads user.teamNames from
                  // `me`, loaded before the purge. Display only: if the reload fails,
                  // the purge still happened and a page refresh shows it.
                  await refresh().catch(() => undefined);
                  void navigate("/teams");
                })
              }
            />
          )}
        </>
      )}
    </Box>
  );
}
