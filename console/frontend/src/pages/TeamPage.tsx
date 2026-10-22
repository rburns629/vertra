// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import { Alert, Box, Button, Chip, Link, Tab, Tabs, Typography } from "@mui/material";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
import { AutomationTab } from "./team/AutomationTab";
import { MembersTab } from "./team/MembersTab";
import { ApisTab } from "./team/ApisTab";
import { RunningTab } from "./team/RunningTab";
import { SecretsTab } from "./team/SecretsTab";

type TabId = "members" | "secrets" | "automation" | "apis" | "running";

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
  const isMember = user?.teamNames.includes(teamName) ?? false;
  // Platform admins can see and manage any team, not just ones they belong
  // to -- see ../../src/auth/access.ts's matching backend checks. Any
  // member sees the tabs; only a maintainer gets their forms. The API
  // refuses either way; this only decides what to show, so nobody sees a
  // 403 they can't act on.
  const canSee = isMember || (user?.isAdmin ?? false);
  const canMaintain = (user?.maintainerOf.includes(teamName) ?? false) || (user?.isAdmin ?? false);
  const [tab, setTab] = useState<TabId>("secrets");
  const [team, setTeam] = useState<Team | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const retired = Boolean(team?.retiredAt);
  const counts = useTabCounts(teamName, tab, canSee);

  useEffect(() => {
    setTeam(null);
    // Display only: if this fails, the page still works without the
    // retired marker, and the forms below surface their own errors.
    getTeam(teamName).then(setTeam).catch(() => undefined);
  }, [teamName]);

  async function changeRetired(next: boolean): Promise<void> {
    setLifecycleError(null);
    setLifecycleBusy(true);
    try {
      await (next ? retireTeam(teamName) : unretireTeam(teamName));
      setTeam(await getTeam(teamName));
    } catch (err) {
      setLifecycleError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setLifecycleBusy(false);
      setConfirmingRetire(false);
    }
  }

  async function purge(): Promise<void> {
    setLifecycleError(null);
    setLifecycleBusy(true);
    try {
      await purgeTeam(teamName);
      // The teams list (and every team picker) reads user.teamNames from
      // `me`, which was loaded before the purge. Display only: if the
      // reload fails, the purge still happened and a page refresh shows it.
      await refresh().catch(() => undefined);
      void navigate("/teams");
    } catch (err) {
      // The server refuses (409) while executions are unfinished; its
      // message says so.
      setLifecycleError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setLifecycleBusy(false);
      setConfirmingPurge(false);
    }
  }

  return (
    <Box>
      <Link component={RouterLink} to="/teams" variant="body2">
        ← Back to teams
      </Link>
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, mt: 0.5, mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 600, fontSize: 28, overflowWrap: "anywhere" }}>
          {teamName}
        </Typography>
        {retired && <Chip label="Retired" size="small" color="warning" />}
        {!isMember && user?.isAdmin && <Chip label="viewing as admin" size="small" />}
        {isMember && !canMaintain && <Chip label="Member: view only" size="small" variant="outlined" />}
        {user?.isAdmin && team && (
          <Button
            size="small"
            variant="outlined"
            color={retired ? "primary" : "warning"}
            disabled={lifecycleBusy}
            sx={{ ml: "auto" }}
            onClick={() => {
              if (retired) void changeRetired(false);
              else setConfirmingRetire(true);
            }}
          >
            {retired ? "Un-retire team" : "Retire team"}
          </Button>
        )}
        {user?.isAdmin && retired && (
          <Button
            size="small"
            variant="contained"
            color="error"
            disabled={lifecycleBusy}
            onClick={() => {
              setConfirmingPurge(true);
            }}
          >
            Purge team
          </Button>
        )}
      </Box>

      {retired && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          This team is retired: it's read-only. Nothing new can be registered, granted or run for
          it, and its products are no longer listed. Its history stays visible.
          {user?.isAdmin ? " Un-retiring restores it." : " An admin can un-retire it."}
        </Alert>
      )}
      {lifecycleError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {lifecycleError}
        </Alert>
      )}
      <ConfirmDialog
        open={confirmingRetire}
        title={`Retire ${teamName}?`}
        description="The team becomes read-only and its products are unregistered. This can be undone. It doesn't stop tasks already running, and it doesn't relabel the team's namespace; for a catalog platform, removing its catalog folder does both."
        confirmLabel="Retire team"
        destructive
        busy={lifecycleBusy}
        onConfirm={() => void changeRetired(true)}
        onCancel={() => {
          setConfirmingRetire(false);
        }}
      />
      <ConfirmDialog
        open={confirmingPurge}
        title={`Purge ${teamName}?`}
        description="This can't be undone. Members, secret grants and bot tokens are removed, and the name stays reserved; execution history is kept. It only covers the console: the team's namespace stays, labelled retired, for a cluster administrator to delete, and its images stay in the registry."
        confirmLabel="Purge team"
        confirmText={teamName}
        destructive
        busy={lifecycleBusy}
        onConfirm={() => void purge()}
        onCancel={() => {
          setConfirmingPurge(false);
        }}
      />

      {!canSee ? (
        <Alert severity="info">
          You're not a member of "{teamName}". Its maintainers (or an admin) can add you.
        </Alert>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(_event, value: TabId) => {
              setTab(value);
            }}
            variant="scrollable"
            allowScrollButtonsMobile
            sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
          >
            {(
              [
                ["members", "Members"],
                ["secrets", "Secrets"],
                ["automation", "Automation"],
                ["apis", "APIs"],
                ["running", "Running now"],
              ] as [TabId, string][]
            )
              // Bots are a maintainer's to see and manage.
              .filter(([id]) => id !== "automation" || canMaintain)
              .map(([id, label]) => (
              <Tab
                key={id}
                value={id}
                label={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {label}
                    {counts[id] !== undefined && counts[id] > 0 && (
                      <Chip label={counts[id]} size="small" sx={{ height: 20, fontSize: 12 }} />
                    )}
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
              onShowAutomation={
                canMaintain
                  ? () => {
                      setTab("automation");
                    }
                  : undefined
              }
            />
          )}
          {tab === "secrets" && <SecretsTab teamName={teamName} readOnly={retired || !canMaintain} />}
          {tab === "automation" && canMaintain && <AutomationTab teamName={teamName} readOnly={retired} />}
          {tab === "apis" && <ApisTab teamName={teamName} />}
          {tab === "running" && <RunningTab teamName={teamName} />}
        </>
      )}
    </Box>
  );
}
