// SPDX-License-Identifier: MIT
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  getTeam,
  getTeamProfile,
  listBots,
  listExecutions,
  listSchedules,
  listTeamPods,
  listTeamSecrets,
  type ApiProduct,
  type ExecutionSummary,
  type PendingApproval,
  type Runnable,
  type Team,
  type TeamProfile,
  type TeamSecret,
} from "../api";
import { useEnvironment } from "../environment";
import { statusLabel } from "../statusColor";
import { when } from "../time";
import { Mono } from "./Mono";
import { Pill } from "./Pill";

const teamHref = (name: string, tab?: string) => `/teams/${encodeURIComponent(name)}${tab ? `?tab=${tab}` : ""}`;

/** Running, or trying to: what the team's "Running now" tab counts. */
export const isRunningPod = (state: string) => state === "running" || state === "starting" || state === "cant-start";

/** One figure on the card, linking to the tab that lists them. */
function Stat({ label, value, to }: { label: string; value: number | undefined; to: string }) {
  return (
    <ButtonBase
      component={RouterLink}
      to={to}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        gap: 0.25,
        p: 1.5,
        minHeight: 44,
        borderRadius: 2,
        bgcolor: "background.default",
        textAlign: "left",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums", color: "text.primary" }}>
        {value ?? "–"}
      </Typography>
    </ButtonBase>
  );
}

/** Names joined with commas, in mono. */
function Names({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={n}>
          {i > 0 && ", "}
          <Mono>{n}</Mono>
        </Fragment>
      ))}
    </>
  );
}

/** What the team offers: its templates, actions and APIs, by name. */
function Offers({ offers, apis }: { offers: Runnable[]; apis: ApiProduct[] }) {
  const unique = (kind: Runnable["kind"]) => [...new Set(offers.filter((r) => r.kind === kind).map((r) => r.name))];
  const templates = unique("template");
  const actions = unique("action");
  const parts: ReactNode[] = [];
  if (templates.length > 0) parts.push(<><Names names={templates} /> {templates.length === 1 ? "template" : "templates"}</>);
  if (actions.length > 0) parts.push(<><Names names={actions} /> {actions.length === 1 ? "action" : "actions"}</>);
  for (const api of apis) {
    parts.push(
      <>
        the{" "}
        <Link component={RouterLink} to={`/apis/${encodeURIComponent(api.team)}/${encodeURIComponent(api.name)}`}>
          {api.displayName || api.name}
        </Link>
      </>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, mb: 0.5 }}>
        What it offers
      </Typography>
      <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && " · "}
            {part}
          </Fragment>
        ))}
      </Typography>
    </Box>
  );
}

interface Loaded {
  team: Team | null;
  profile: TeamProfile | null;
  running: number | undefined;
  secrets: TeamSecret[] | undefined;
  /** Bots for a maintainer, schedules for a member. */
  fourth: number | undefined;
  lastRun: ExecutionSummary | null;
}

/** Everything the card shows of one team. Display only: a figure that
 * couldn't be loaded shows as a dash, and the team's page has the rest. */
function useTeamSummary(name: string, maintains: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ team: null, profile: null, running: undefined, secrets: undefined, fourth: undefined, lastRun: null });
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getTeam(name),
      getTeamProfile(name),
      listTeamPods(name),
      listTeamSecrets(name),
      maintains ? listBots(name).then((b) => b.length) : listSchedules(name).then((s) => s.length),
      listExecutions({ team: name, limit: 1 }),
    ]).then(([team, profile, pods, secrets, fourth, runs]) => {
      if (cancelled) return;
      setLoaded({
        team: team.status === "fulfilled" ? team.value : null,
        profile: profile.status === "fulfilled" ? profile.value : null,
        running: pods.status === "fulfilled" ? pods.value.filter((p) => isRunningPod(p.state)).length : undefined,
        secrets: secrets.status === "fulfilled" ? secrets.value : undefined,
        fourth: fourth.status === "fulfilled" ? fourth.value : undefined,
        lastRun: runs.status === "fulfilled" ? (runs.value.executions[0] ?? null) : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [name, maintains]);
  return loaded;
}

/**
 * One of your teams at a glance: your role, its people, what's running,
 * its secrets and bots (or schedules), what it offers, and what needs
 * attention (steps waiting for its approval, secrets that don't sync).
 * The team's description in the catalog isn't shown: the API doesn't carry it.
 */
export function TeamCard({
  name,
  maintains,
  offers,
  apis,
  approvals,
}: {
  name: string;
  /** You maintain it (or you're an admin who's a member). */
  maintains: boolean;
  /** Its templates and actions, and its APIs. */
  offers: Runnable[];
  apis: ApiProduct[];
  /** Its steps waiting for its approval. */
  approvals: PendingApproval[];
}) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const install = useEnvironment()?.label ?? "";
  const { team, profile, running, secrets, fourth, lastRun } = useTeamSummary(name, maintains);
  const failing = (secrets ?? []).filter((s) => s.external?.status === "error");
  const checked = offers.filter((r) => r.readiness);
  const allReady = checked.length > 0 && checked.every((r) => r.readiness?.state === "ready");
  const attention = approvals.length > 0 || failing.length > 0;

  return (
    <Card component="article" sx={{ p: { xs: 2, sm: 2.5 }, display: "flex", flexDirection: "column", gap: 2, height: "100%" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1, flexWrap: "wrap" }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h3" sx={{ fontSize: 20, overflowWrap: "anywhere" }}>
            <Link component={RouterLink} to={teamHref(name)} underline="hover" color="text.primary">
              {name}
            </Link>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            Namespace <Mono>{name}</Mono>
            {team && (team.fromCatalog ? " · from the catalog" : " · made here")}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
          <Pill tone={maintains ? "info" : "neutral"}>{maintains ? "You maintain it" : "You're a member"}</Pill>
          {team?.retiredAt && <Pill tone="neutral">Retired</Pill>}
          {sso && team?.requireSso && <Pill tone="neutral">{sso} sign-in only</Pill>}
        </Box>
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(4, minmax(0, 1fr))" }, gap: 1 }}>
        <Stat label="People" value={profile?.people} to={teamHref(name)} />
        <Stat label="Running now" value={running} to={teamHref(name, "running")} />
        <Stat label="Secrets" value={secrets?.length} to={teamHref(name, "secrets")} />
        {maintains ? <Stat label="Bots" value={fourth} to={teamHref(name, "automation")} /> : <Stat label="Schedules" value={fourth} to={teamHref(name, "schedules")} />}
      </Box>

      <Offers offers={offers} apis={apis} />

      {attention ? (
        <Box role="status" sx={{ display: "flex", gap: 1, p: 1.5, borderRadius: 2, bgcolor: "warning.light", color: "warning.dark" }}>
          <Box component="span" aria-hidden="true" sx={{ width: 7, height: 7, mt: 0.9, borderRadius: "50%", bgcolor: "warning.main", flexShrink: 0 }} />
          <Typography variant="body2" component="div" sx={{ color: "inherit", overflowWrap: "anywhere" }}>
            {approvals.length > 0 && (
              <>
                {approvals.length === 1 ? "1 step waits" : `${String(approvals.length)} steps wait`} for {name} to approve:{" "}
                {approvals.slice(0, 2).map((a, i) => (
                  <Fragment key={`${a.executionId}/${a.taskId}`}>
                    {i > 0 && ", "}
                    <Link component={RouterLink} to={`/runs/${a.executionId}`} sx={{ color: "inherit" }}>
                      {a.executionName || a.executionId}
                    </Link>
                  </Fragment>
                ))}
                {approvals.length > 2 && " and more"}.{" "}
              </>
            )}
            {failing.length > 0 && (
              <>
                {failing.length === 1 ? "1 secret has" : `${String(failing.length)} secrets have`} a sync error:{" "}
                <Names names={failing.map((s) => s.secretName)} />.
              </>
            )}
          </Typography>
        </Box>
      ) : (
        (allReady || lastRun) && (
          <Typography variant="body2" sx={{ display: "flex", gap: 1, alignItems: "baseline", color: allReady ? "success.main" : "text.secondary" }}>
            {allReady && <Box component="span" aria-hidden="true" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "success.main", flexShrink: 0, alignSelf: "center" }} />}
            <span>
              {allReady && `Every product ready${install ? ` on ${install}` : ""}`}
              {allReady && lastRun && " · "}
              {lastRun && `last run ${lastRun.state ? statusLabel(lastRun.state) : "submitted"}, ${when(lastRun.createdAt)}`}
            </span>
          </Typography>
        )
      )}

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: "auto", pt: 2, borderTop: 1, borderColor: "divider" }}>
        <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name)}>
          Members
        </Button>
        {maintains ? (
          <>
            <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name, "secrets")}>
              Secrets
            </Button>
            <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name, "automation")}>
              Automation
            </Button>
            <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name, "settings")}>
              Settings
            </Button>
          </>
        ) : (
          <>
            <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name, "offers")}>
              What it offers
            </Button>
            <Button variant="outlined" color="inherit" component={RouterLink} to={teamHref(name, "running")}>
              Running now
            </Button>
          </>
        )}
      </Box>
    </Card>
  );
}
