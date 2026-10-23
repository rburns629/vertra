// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { ApiError, listExecutions, listPendingApprovals, type ExecutionSummary, type PendingApproval } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Pill } from "../components/Pill";
import { duration, useNow, when } from "../time";

const DAYS = 14;
const LIVE = new Set(["RUNNING", "PENDING", "AWAITING_APPROVAL"]);

function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** Midnight, local time, `days` ago. */
function dayStart(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function stepsOf(run: ExecutionSummary): { done: number; total: number } {
  const total = Object.values(run.steps).reduce((a, b) => a + b, 0);
  return { done: run.steps["SUCCEEDED"] ?? 0, total };
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Card>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 30, fontWeight: 600, lineHeight: 1.2 }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">
        {note}
      </Typography>
    </Card>
  );
}

/** Your runs a day over the last two weeks: a bar a day, today's darker. */
function RunsByDay({ runs }: { runs: ExecutionSummary[] }) {
  const days = useMemo(() => {
    const counts = Array.from({ length: DAYS }, (_, i) => ({ start: dayStart(DAYS - 1 - i), n: 0 }));
    for (const run of runs) {
      const at = Date.parse(run.createdAt);
      const day = counts.findLast((d) => at >= d.start.getTime());
      if (day) day.n += 1;
    }
    return counts;
  }, [runs]);
  const most = Math.max(1, ...days.map((d) => d.n));
  const label = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <Box>
      <Box
        role="img"
        aria-label={days.map((d) => `${label(d.start)}: ${String(d.n)}`).join(", ")}
        sx={{ display: "flex", alignItems: "flex-end", gap: "4px", height: 120 }}
      >
        {days.map((d, i) => (
          <Box
            key={d.start.toISOString()}
            title={`${label(d.start)}: ${String(d.n)} run${d.n === 1 ? "" : "s"}`}
            sx={{
              flex: "1 1 0",
              height: `${String(Math.max(d.n ? 6 : 2, (d.n / most) * 100))}%`,
              borderRadius: "4px 4px 0 0",
              bgcolor: i === DAYS - 1 ? "primary.main" : d.n ? "#8FA9EC" : "divider",
            }}
          />
        ))}
      </Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.75 }}>
        <Typography variant="caption" color="text.secondary">
          {days[0] ? label(days[0].start) : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Today
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * Home: your own runs (what's going, how the last two weeks went), what
 * waits for you to decide, and your teams.
 */
export function HomePage() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<ExecutionSummary[] | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listExecutions({ mine: true, since: dayStart(DAYS - 1).toISOString(), limit: 1000 })
      .then((page) => { setRuns(page.executions); })
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load your runs."); });
    listPendingApprovals()
      .then((list) => { setApprovals(list.filter((a) => a.canDecide)); })
      .catch(() => undefined);
  }, []);

  const live = useMemo(() => (runs ?? []).filter((r) => r.state && LIVE.has(r.state)), [runs]);
  const now = useNow(live.length > 0);
  if (!user) return null;

  const weekStart = dayStart(6).getTime();
  const thisWeek = (runs ?? []).filter((r) => Date.parse(r.createdAt) >= weekStart);
  const lastWeek = (runs ?? []).length - thisWeek.length;
  const finished = thisWeek.filter((r) => r.state === "SUCCEEDED" || r.state === "FAILED");
  const failed = finished.filter((r) => r.state === "FAILED").length;
  const succeeded = finished.length ? Math.round(((finished.length - failed) / finished.length) * 100) : null;
  const longest = live.reduce((most, r) => Math.max(most, now - Date.parse(r.createdAt)), 0);
  const name = user.email.split("@")[0];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 2 }}>
        <Box>
          <Typography variant="h4" component="h1">
            {greeting(new Date().getHours())}, {name}
          </Typography>
          <Typography color="text.secondary">
            {runs === null
              ? " "
              : live.length > 0
                ? `${String(live.length)} of your runs ${live.length === 1 ? "is" : "are"} going.`
                : "Nothing of yours is running."}
            {approvals.length > 0 && ` ${String(approvals.length)} ${approvals.length === 1 ? "step waits" : "steps wait"} for you to approve.`}
          </Typography>
        </Box>
        <Button variant="contained" component={RouterLink} to="/catalog">
          Run something
        </Button>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" } }}>
        <Tile
          label="Your runs this week"
          value={runs ? String(thisWeek.length) : "—"}
          note={runs ? (thisWeek.length === lastWeek ? "as many as last week" : `${String(Math.abs(thisWeek.length - lastWeek))} ${thisWeek.length > lastWeek ? "more" : "fewer"} than last week`) : ""}
        />
        <Tile label="Succeeded" value={succeeded === null ? "—" : `${String(succeeded)}%`} note={failed ? `${String(failed)} failed this week` : "of those finished this week"} />
        <Tile label="Running now" value={runs ? String(live.length) : "—"} note={live.length ? `longest: ${duration(longest)}` : "nothing of yours"} />
        <Tile label="Waiting on you" value={String(approvals.length)} note={approvals.length ? "steps to approve" : "nothing to decide"} />
      </Box>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Panel
            title="Running now"
            action={
              <Link component={RouterLink} to="/runs" variant="body2">
                All runs
              </Link>
            }
          >
            {runs === null && <Skeleton variant="rounded" height={64} />}
            {runs !== null && live.length === 0 && (
              <Typography color="text.secondary">
                Nothing of yours is running. <Link component={RouterLink} to="/catalog">Find something to run</Link>.
              </Typography>
            )}
            {live.map((r) => {
              const { done, total } = stepsOf(r);
              return (
                <Box key={r.executionId} sx={{ display: "flex", flexDirection: "column", gap: 0.75, py: 1, borderTop: 1, borderColor: "divider", "&:first-of-type": { borderTop: 0 } }}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "baseline" }}>
                    <Link component={RouterLink} to={`/runs/${encodeURIComponent(r.executionId)}`} sx={{ fontWeight: 500 }}>
                      {r.name}
                    </Link>
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                      {duration(now - Date.parse(r.createdAt))}
                    </Typography>
                  </Box>
                  <Box sx={{ height: 6, borderRadius: 3, bgcolor: "divider", overflow: "hidden" }} aria-hidden="true">
                    <Box sx={{ height: "100%", width: `${String(total ? Math.max(4, (done / total) * 100) : 4)}%`, bgcolor: r.state === "AWAITING_APPROVAL" ? "warning.main" : "primary.main", borderRadius: 3 }} />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {r.state === "AWAITING_APPROVAL" ? "Waiting for an approval" : `${String(done)} of ${String(total)} steps done`}
                  </Typography>
                </Box>
              );
            })}
          </Panel>

          <Panel title="Your runs, last 14 days" action={<Typography variant="body2" color="text.secondary">{runs ? `${String(runs.length)} runs` : ""}</Typography>}>
            {runs === null ? <Skeleton variant="rounded" height={140} /> : <RunsByDay runs={runs} />}
          </Panel>
        </Box>

        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Panel title="Needs you">
            {approvals.length === 0 && <Typography color="text.secondary">Nothing waits for you.</Typography>}
            {approvals.map((a) => (
              <Box key={`${a.executionId}/${a.taskId}`} sx={{ display: "flex", flexDirection: "column", gap: 0.5, py: 1, borderTop: 1, borderColor: "divider", "&:first-of-type": { borderTop: 0 } }}>
                <Typography sx={{ fontWeight: 500 }}>Approve a step for {a.team}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {a.requestedBy || "Someone"} asked to run {a.taskId} in {a.executionName}
                  {a.awaitingSince ? `, ${when(a.awaitingSince)}` : ""}.
                </Typography>
                <Box>
                  <Button size="small" component={RouterLink} to={`/runs/${encodeURIComponent(a.executionId)}`}>
                    Review it
                  </Button>
                </Box>
              </Box>
            ))}
          </Panel>

          <Panel title="Your teams">
            {user.teamNames.length === 0 && (
              <Typography color="text.secondary">You&apos;re not in a team yet: a team&apos;s maintainers or an admin can add you.</Typography>
            )}
            {user.teamNames.map((t) => (
              <Box key={t} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1 }}>
                <Link component={RouterLink} to={`/teams/${encodeURIComponent(t)}`}>
                  {t}
                </Link>
                <Pill tone={user.maintainerOf.includes(t) ? "info" : "neutral"}>{user.maintainerOf.includes(t) ? "Maintainer" : "Member"}</Pill>
              </Box>
            ))}
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}
