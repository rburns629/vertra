// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import { useTheme } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Link from "@mui/material/Link";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import PeopleIcon from "@mui/icons-material/PeopleOutlined";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import PlayCircleIcon from "@mui/icons-material/PlayCircleOutlined";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { MetricCard } from "../components/MetricCard";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { statusFill, statusLabel } from "../statusColor";
import {
  ApiError,
  getStats,
  listExecutions,
  listPendingApprovals,
  type ExecutionSummary,
  type PendingApproval,
  type PlatformStats,
} from "../api";
import { useAuth } from "../auth/AuthContext";

const APPROVAL_COLUMNS: DataTableColumn<PendingApproval>[] = [
  { key: "run", header: "Run", render: (a) => a.executionName || a.executionId },
  { key: "step", header: "Step", render: (a) => `${a.taskId} (${a.team})` },
  { key: "by", header: "Run by", render: (a) => a.requestedBy || "—", hideBelow: "sm" },
  {
    key: "since",
    header: "Waiting since",
    render: (a) => (a.awaitingSince ? new Date(a.awaitingSince).toLocaleString() : "—"),
    hideBelow: "md",
  },
  { key: "you", header: "", render: (a) => (a.canDecide ? "" : "You ran it: another maintainer decides"), hideBelow: "sm" },
];

const CHART_STATUS_ORDER = ["SUCCEEDED", "FAILED", "RUNNING", "PENDING", "CANCELLED"];

type BucketUnit = "hour" | "day" | "week" | "month";

/** The time ranges the charts offer. `count` buckets of `unit`, ending
 * with the current one; "all" sizes its buckets to the history it has. */
const RANGES = [
  { id: "24h", label: "24 hours", unit: "hour", count: 24, phrase: "in the last 24 hours" },
  { id: "7d", label: "7 days", unit: "day", count: 7, phrase: "in the last 7 days" },
  { id: "30d", label: "30 days", unit: "day", count: 30, phrase: "in the last 30 days" },
  { id: "90d", label: "90 days", unit: "week", count: 13, phrase: "in the last 90 days" },
  { id: "all", label: "All", unit: null, count: null, phrase: "yet" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const DEFAULT_RANGE: RangeId = "7d";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The most executions the charts are drawn from. */
const HOME_LIMIT = 1000;

/** The start of a range, as the list's `since`; undefined for "All". */
function rangeSince(rangeId: RangeId): string | undefined {
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, all: null }[rangeId];
  return days === null ? undefined : new Date(Date.now() - days * DAY_MS).toISOString();
}

/** The two chart cards stretch to the taller one's height (a Grid row's
 * items already do), and the bar chart grows to fill its card. */
const CHART_CARD = { height: "100%", display: "flex", flexDirection: "column" } as const;
const CHART_CARD_CONTENT = { flexGrow: 1, display: "flex", flexDirection: "column" } as const;

/** The start of the bucket `date` falls in, in local time (weeks start Monday). */
function bucketStart(date: Date, unit: BucketUnit): Date {
  const d = new Date(date);
  if (unit === "hour") {
    d.setMinutes(0, 0, 0);
    return d;
  }
  d.setHours(0, 0, 0, 0);
  if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === "month") d.setDate(1);
  return d;
}

function addBuckets(date: Date, unit: BucketUnit, n: number): Date {
  const d = new Date(date);
  if (unit === "hour") d.setHours(d.getHours() + n);
  if (unit === "day") d.setDate(d.getDate() + n);
  if (unit === "week") d.setDate(d.getDate() + 7 * n);
  if (unit === "month") d.setMonth(d.getMonth() + n);
  return d;
}

function bucketLabel(date: Date, unit: BucketUnit): string {
  if (unit === "hour") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (unit === "month") return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** For "All": buckets small enough to show a shape, few enough to read. */
function unitForSpan(spanMs: number): BucketUnit {
  if (spanMs <= 2 * DAY_MS) return "hour";
  if (spanMs <= 60 * DAY_MS) return "day";
  if (spanMs <= 365 * DAY_MS) return "week";
  return "month";
}

/** Both charts below are computed client-side from the same executions
 * list the "Recent executions" table already renders -- state and
 * createdAt are real, per-execution fields (see ../api.ts's
 * ExecutionSummary), not a separate aggregation endpoint. GET /executions
 * returns the caller's whole history, so any range can be drawn from it.
 * Every bucket in the range is drawn, empty ones included, oldest first,
 * so the bars are evenly spaced in time. */
function useBreakdown(executions: ExecutionSummary[] | null, rangeId: RangeId) {
  const theme = useTheme();
  return useMemo(() => {
    if (!executions) return { byTime: [], byStatus: [], total: 0 };
    const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1];
    const now = new Date();
    const oldest = executions.reduce(
      (min, e) => Math.min(min, new Date(e.createdAt).getTime()),
      now.getTime(),
    );
    const unit: BucketUnit = range.unit ?? unitForSpan(now.getTime() - oldest);
    const last = bucketStart(now, unit);
    const first = range.count === null ? bucketStart(new Date(oldest), unit) : addBuckets(last, unit, 1 - range.count);

    const buckets = new Map<number, Record<string, number>>();
    for (let t = first; t <= last; t = addBuckets(t, unit, 1)) buckets.set(t.getTime(), {});

    const statusTotals = new Map<string, number>();
    let total = 0;
    for (const execution of executions) {
      const created = new Date(execution.createdAt);
      if (created < first) continue;
      const bucket = buckets.get(bucketStart(created, unit).getTime());
      if (!bucket) continue;
      const state = execution.state ?? "PENDING";
      bucket[state] = (bucket[state] ?? 0) + 1;
      statusTotals.set(state, (statusTotals.get(state) ?? 0) + 1);
      total += 1;
    }

    const byTime = Array.from(buckets.entries()).map(([start, counts]) => ({
      label: bucketLabel(new Date(start), unit),
      ...counts,
    }));
    const byStatus = CHART_STATUS_ORDER.filter((s) => statusTotals.has(s)).map((state) => ({
      state,
      label: statusLabel(state),
      value: statusTotals.get(state) ?? 0,
      color: statusFill(theme, state),
    }));
    return { byTime, byStatus, total };
  }, [executions, rangeId, theme]);
}

export function HomePage() {
  const theme = useTheme();
  const { user } = useAuth();
  const navigate = useNavigate();
  // In the URL, so a link or a reload keeps the chosen range.
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats,setStats] = useState<PlatformStats | null>(null);
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  const requestedRange = searchParams.get("range");
  const rangeId: RangeId = RANGES.some((r) => r.id === requestedRange) ? (requestedRange as RangeId) : DEFAULT_RANGE;

  useEffect(() => {
    let cancelled = false;
    listExecutions({ since: rangeSince(rangeId), limit: HOME_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setExecutions(page.executions);
        setCapped(page.nextCursor !== null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load executions.");
      });
    return () => {
      cancelled = true;
    };
  }, [rangeId]);

  // Steps waiting for a maintainer's approval, in the teams this user maintains.
  useEffect(() => {
    let cancelled = false;
    listPendingApprovals()
      .then((pending) => {
        if (!cancelled) setApprovals(pending);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load approvals.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const requests: Promise<unknown>[] = [];
    if (user?.isAdmin) {
      requests.push(
        getStats()
          .then(setStats)
          .catch((err: unknown) => {
            setError(err instanceof ApiError ? err.message : "Failed to load stats.");
          }),
      );
    }
    void Promise.all(requests);
  }, [user?.isAdmin]);

  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1];
  const { byTime, byStatus, total } = useBreakdown(executions, rangeId);

  if (!user) return null;

  const cards = user.isAdmin
    ? [
        { label: "Teams", value: stats?.teams, icon: <GroupsIcon fontSize="small" /> },
        { label: "Users", value: stats?.users, icon: <PeopleIcon fontSize="small" /> },
        { label: "Products", value: stats?.products, icon: <InventoryIcon fontSize="small" /> },
        { label: "Executions", value: stats?.executions, icon: <PlayCircleIcon fontSize="small" /> },
      ]
    : [
        { label: "Your teams", value: user.teamNames.length, icon: <GroupsIcon fontSize="small" /> },
        { label: "Your executions", value: executions?.length, icon: <PlayCircleIcon fontSize="small" /> },
      ];

  const columns: DataTableColumn<ExecutionSummary>[] = [
    {
      key: "reference",
      header: "Reference",
      render: (e) => (
        <Link
          href={`/runs/${encodeURIComponent(e.executionId)}`}
          onClick={(event) => {
            event.preventDefault();
            navigate(`/runs/${encodeURIComponent(e.executionId)}`);
          }}
        >
          {e.name}
        </Link>
      ),
    },
    {
      key: "teams",
      header: "Teams",
      render: (e) => (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          {e.teams.map((team) => (
            <Chip key={team} label={team} size="small" />
          ))}
        </Box>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (e) => (e.state ? <StatusBadge status={e.state} /> : "—"),
    },
    {
      key: "submitted",
      header: "Submitted",
      render: (e) => new Date(e.createdAt).toLocaleString(),
    },
  ];

  return (
    <Box>
      <PageHeader
        title={`Welcome back, ${user.email.split("@")[0]}`}
        subtitle="Here's what's happening with your DAG executions."
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {approvals.length > 0 && (
        <Card variant="outlined" sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
              Waiting for approval
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Steps of teams you maintain that wait for a maintainer to approve them. Open one to approve or decline it.
            </Typography>
            <DataTable
              columns={APPROVAL_COLUMNS}
              rows={approvals}
              getRowKey={(a) => `${a.executionId}/${a.taskId}`}
              onRowClick={(a) => { navigate(`/runs/${a.executionId}`); }}
            />
          </CardContent>
        </Card>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {cards.map((card) => (
          <Grid key={card.label} size={{ xs: 6, sm: 3 }}>
            <MetricCard label={card.label} value={card.value ?? "…"} icon={card.icon} />
          </Grid>
        ))}
      </Grid>

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1, mb: 1, flexWrap: "wrap" }}>
        <Typography variant="body2" color="text.secondary">
          Show
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={rangeId}
          aria-label="Time range for the charts"
          onChange={(_event, value: RangeId | null) => {
            if (!value) return;
            setSearchParams(
              (params) => {
                if (value === DEFAULT_RANGE) params.delete("range");
                else params.set("range", value);
                return params;
              },
              { replace: true },
            );
          }}
        >
          {RANGES.map((r) => (
            <ToggleButton key={r.id} value={r.id} sx={{ px: 1.5, py: 0.25, textTransform: "none" }}>
              {r.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card variant="outlined" sx={CHART_CARD}>
            <CardContent sx={CHART_CARD_CONTENT}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                Executions over time
              </Typography>
              <Box sx={{ flexGrow: 1, minHeight: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byTime}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" fontSize={12} minTickGap={8} />
                    <YAxis allowDecimals={false} fontSize={12} />
                    <Tooltip />
                    <Legend formatter={(value: string) => statusLabel(value)} />
                    {CHART_STATUS_ORDER.map((state) => (
                      <Bar key={state} dataKey={state} stackId="a" fill={statusFill(theme, state)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Card variant="outlined" sx={CHART_CARD}>
            <CardContent sx={CHART_CARD_CONTENT}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
                Execution status
              </Typography>
              <Box sx={{ height: 200, position: "relative" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={byStatus} dataKey="value" nameKey="label" innerRadius={55} outerRadius={80}>
                      {byStatus.map((entry) => (
                        <Cell key={entry.state} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <Box
                  sx={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    textAlign: "center",
                    pointerEvents: "none",
                  }}
                >
                  <Typography variant="h5" sx={{ fontWeight: 700 }}>
                    {total}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {capped ? `Latest ${HOME_LIMIT.toLocaleString()}` : "Total"}
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 1 }}>
                {byStatus.map((entry) => (
                  <Box key={entry.state} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: entry.color }} />
                    <Typography variant="body2" sx={{ flexGrow: 1 }}>
                      {entry.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {entry.value} ({total > 0 ? Math.round((entry.value / total) * 100) : 0}%)
                    </Typography>
                  </Box>
                ))}
                {byStatus.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    No executions {range.phrase}.
                  </Typography>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Recent executions
            </Typography>
            <Link
              href="/runs"
              onClick={(event) => {
                event.preventDefault();
                navigate("/runs");
              }}
            >
              View all executions →
            </Link>
          </Box>
          <DataTable
            columns={columns}
            rows={executions ? executions.slice(0, 8) : null}
            getRowKey={(e) => e.executionId}
            onRowClick={(e) => { navigate(`/runs/${encodeURIComponent(e.executionId)}`); }}
            emptyMessage={
              <>
                No executions visible yet
                {!user.isAdmin && " -- only ones belonging to your teams show up here"}.
              </>
            }
          />
        </CardContent>
      </Card>
    </Box>
  );
}
