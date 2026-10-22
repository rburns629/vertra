// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import BlockIcon from "@mui/icons-material/BlockOutlined";
import GppGoodIcon from "@mui/icons-material/GppGoodOutlined";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import ReportIcon from "@mui/icons-material/ReportProblemOutlined";
import HourglassIcon from "@mui/icons-material/HourglassEmptyOutlined";
import PlayCircleIcon from "@mui/icons-material/PlayCircleOutlined";
import ErrorIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { MetricCard } from "../components/MetricCard";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { ApiError, getMetrics, getSecurity, type MetricsView, type SecurityView } from "../api";

type TabId = "security" | "metrics";
const TABS: [TabId, string][] = [
  ["security", "Security checks"],
  ["metrics", "Metrics"],
];

const STATE: Record<string, { label: string; color: "success" | "warning" | "default" }> = {
  enforced: { label: "Enforced", color: "success" },
  off: { label: "Off here", color: "warning" },
  not_yet: { label: "Not yet", color: "default" },
};

const SCAN: Record<string, { label: string; color: "success" | "error" | "warning" | "default" }> = {
  passed: { label: "Passed", color: "success" },
  failed: { label: "Failed", color: "error" },
  error: { label: "Couldn't scan", color: "warning" },
  pending: { label: "Scanning", color: "default" },
  unscanned: { label: "Not scanned", color: "default" },
};

const stateOf = (state: string) => STATE[state] ?? { label: "Not yet", color: "default" as const };
const scanOf = (scan: string) => SCAN[scan] ?? { label: "Not scanned", color: "default" as const };

type Refusal = SecurityView["refusals"][number];
type Image = SecurityView["images"][number];

const REFUSALS: DataTableColumn<Refusal>[] = [
  { key: "when", header: "When", render: (r) => (r.at ? new Date(r.at).toLocaleString() : "—"), hideBelow: "sm" },
  {
    key: "what",
    header: "What",
    render: (r) =>
      r.executionId ? (
        <Link component={RouterLink} to={`/executions/${r.executionId}`}>
          {r.what}
        </Link>
      ) : (
        r.what
      ),
  },
  {
    key: "why",
    header: "Why",
    render: (r) => (
      <Box>
        <Mono>{r.code}</Mono> {r.why}
      </Box>
    ),
  },
];

const IMAGES: DataTableColumn<Image>[] = [
  {
    key: "product",
    header: "Product",
    render: (i) => (
      <Box>
        <Typography variant="body2">{i.product}</Typography>
        <Typography variant="caption" color="text.secondary">
          {i.team}
        </Typography>
      </Box>
    ),
  },
  { key: "digest", header: "Digest", render: (i) => <Mono>{(/@sha256:([0-9a-f]{12})/.exec(i.image)?.[1] ?? "") || "—"}</Mono>, hideBelow: "md" },
  {
    key: "scan",
    header: "Last scan",
    render: (i) => (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip size="small" label={scanOf(i.scan).label} color={scanOf(i.scan).color} />
        {(i.fixable > 0 || i.secrets > 0) && (
          <Typography variant="caption" color="text.secondary">
            {i.fixable} fixable{i.secrets > 0 ? `, ${String(i.secrets)} secrets` : ""}
          </Typography>
        )}
        {i.acceptedReason && (
          <Typography variant="caption" color="text.secondary">
            accepted: {i.acceptedReason}
          </Typography>
        )}
      </Stack>
    ),
  },
  { key: "when", header: "Scanned", render: (i) => (i.scannedAt ? new Date(i.scannedAt).toLocaleString() : "—"), hideBelow: "md" },
];

/**
 * Observe: what this install checks, what it refused, and what everything
 * is doing. Everyone signed in sees the security checks; a run's details
 * follow who may see that run.
 */
export function ObservePage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([id]) => id === params.get("tab"))?.[0] ?? "security") satisfies TabId;
  return (
    <Box>
      <PageHeader
        title="Observe"
        subtitle="What this install checks, what it refused, and what everything is doing. Everyone can see this; logs follow who can see each run."
      />
      <Tabs
        value={tab}
        onChange={(_e, value: TabId) => {
          setParams({ tab: value });
        }}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
      >
        {TABS.map(([id, label]) => (
          <Tab key={id} value={id} label={label} />
        ))}
      </Tabs>
      {tab === "security" && <SecurityTab />}
      {tab === "metrics" && <MetricsTab />}
    </Box>
  );
}

function SecurityTab() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    getSecurity()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load the security checks.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const images = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!view) return null;
    return q ? view.images.filter((i) => [i.product, i.team, i.image].some((s) => s.toLowerCase().includes(q))) : view.images;
  }, [view, filter]);

  const enforced = view?.checks.filter((c) => c.state === "enforced").length ?? 0;
  const failing = view?.images.filter((i) => i.scan === "failed" && !i.acceptedReason).length ?? 0;
  const shown = (n: number) => (view ? n.toLocaleString() : "—");

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" } }}>
        <MetricCard label="Checks enforced" value={view ? `${String(enforced)} of ${String(view.checks.length)}` : "—"} icon={<GppGoodIcon fontSize="small" />} />
        <MetricCard label="Images allowed" value={shown(view?.images.length ?? 0)} icon={<InventoryIcon fontSize="small" />} />
        <MetricCard label="Failing scans" value={shown(failing)} icon={<ReportIcon fontSize="small" />} />
        <MetricCard label="Refused, 7 days" value={shown(view?.refusals.length ?? 0)} icon={<BlockIcon fontSize="small" />} />
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            What this install enforces
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each one checked by the cluster itself, not only by the console. What isn&apos;t enforced yet says so.
          </Typography>
          <Stack spacing={1.5}>
            {view?.checks.map((c) => (
              <Box key={c.name} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "110px 1fr" }, gap: 1, alignItems: "start" }}>
                <Box>
                  <Chip size="small" label={stateOf(c.state).label} color={stateOf(c.state).color} />
                </Box>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {c.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {c.text}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            Refused, last 7 days
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Steps the cluster wouldn&apos;t start, and catalog releases the console couldn&apos;t apply. A run is linked when you may see it.
          </Typography>
          <DataTable columns={REFUSALS} rows={view?.refusals ?? null} getRowKey={(r) => `${r.at ?? ""}/${r.what}/${r.code}`} emptyMessage="Nothing refused this week." />
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            Every image allowed to run here
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Pinned to a digest, scanned before it may run, and rescanned against new advisories while it&apos;s in use.
          </Typography>
          <TextField
            size="small"
            placeholder="Filter images"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
            sx={{ mb: 2, width: { xs: "100%", sm: 320 } }}
            slotProps={{ htmlInput: { "aria-label": "Filter images" } }}
          />
          <DataTable columns={IMAGES} rows={images} getRowKey={(i) => i.product} emptyMessage="No products registered yet." />
        </CardContent>
      </Card>
    </Stack>
  );
}

type Failure = MetricsView["failures"][number];
type ProductTimes = MetricsView["products"][number];

/** 0.4 s, 12 s, 3 min 5 s, 1 h 2 min. */
function duration(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${String(Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m)} min ${String(Math.round(seconds % 60))} s`;
  return `${String(Math.floor(m / 60))} h ${String(m % 60)} min`;
}

const FAILURES: DataTableColumn<Failure>[] = [
  { key: "code", header: "Code", render: (f) => <Mono>{f.code || "(none)"}</Mono> },
  { key: "count", header: "Steps", render: (f) => f.count.toLocaleString(), align: "right" },
  {
    key: "means",
    header: "What it means",
    render: (f) => (
      <Box>
        {f.means || "—"}
        {f.retried && (
          <Typography variant="caption" color="text.secondary" component="div">
            Some were retried automatically.
          </Typography>
        )}
      </Box>
    ),
    hideBelow: "sm",
  },
];

const PRODUCTS: DataTableColumn<ProductTimes>[] = [
  {
    key: "product",
    header: "Product",
    render: (p) => (
      <Box>
        <Typography variant="body2">
          {p.product} <Mono>{p.action}</Mono>
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {p.team}
        </Typography>
      </Box>
    ),
  },
  { key: "steps", header: "Steps", render: (p) => p.steps.toLocaleString(), align: "right" },
  { key: "ok", header: "Succeeded", render: (p) => (p.steps ? `${String(Math.round((100 * p.succeeded) / p.steps))}%` : "—"), align: "right" },
  { key: "p50", header: "Median", render: (p) => duration(p.p50Seconds), align: "right", hideBelow: "sm" },
  { key: "p95", header: "95th percentile", render: (p) => duration(p.p95Seconds), align: "right" },
];

/** One series over the last 24 hours, one axis. */
function HourChart({ data, dataKey, label, format }: { data: { label: string }[]; dataKey: string; label: string; format: (n: number) => string }) {
  const theme = useTheme();
  return (
    <Box sx={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme.palette.divider} />
          <XAxis dataKey="label" fontSize={12} minTickGap={16} stroke={theme.palette.text.secondary} />
          <YAxis allowDecimals={false} fontSize={12} width={48} tickFormatter={format} stroke={theme.palette.text.secondary} />
          <Tooltip formatter={(v) => [format(Number(v)), label]} contentStyle={{ background: theme.palette.background.paper, borderColor: theme.palette.divider }} />
          <Bar dataKey={dataKey} fill={theme.palette.primary.main} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

function MetricsTab() {
  const [view, setView] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMetrics()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load the metrics.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hours = useMemo(
    () =>
      (view?.hours ?? []).map((h) => ({
        label: h.hour ? new Date(h.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
        started: h.started,
        wait: h.waitP95Seconds,
      })),
    [view],
  );
  const started = view?.hours.reduce((n, h) => n + h.started, 0);
  const failed = view?.failures.reduce((n, f) => n + f.count, 0);
  const shown = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" } }}>
        <MetricCard label="Waiting to start now" value={shown(view?.ready)} icon={<HourglassIcon fontSize="small" />} />
        <MetricCard label="Running now" value={shown(view?.running)} icon={<PlayCircleIcon fontSize="small" />} />
        <MetricCard label="Started, 24 hours" value={shown(started)} icon={<PlayCircleIcon fontSize="small" />} />
        <MetricCard label="Failed attempts, 24 hours" value={shown(failed)} icon={<ErrorIcon fontSize="small" />} />
      </Box>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Steps started, by hour
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Every attempt, retries included, over the last 24 hours.
            </Typography>
            <HourChart data={hours} dataKey="started" label="Started" format={(n) => n.toLocaleString()} />
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Wait to start, 95th percentile
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              From a step becoming ready to its Pod starting. A rising wait means the cluster or the scheduler is short of room.
            </Typography>
            <HourChart data={hours} dataKey="wait" label="Wait, p95" format={duration} />
          </CardContent>
        </Card>
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            Why steps failed, last 24 hours
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Each failed attempt by its code. A product&apos;s own codes are explained in its documentation.
          </Typography>
          <DataTable columns={FAILURES} rows={view?.failures ?? null} getRowKey={(f) => f.code} emptyMessage="No failures." />
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            Step times by product, last 7 days
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            How long each product&apos;s action runs once started, slowest first.
          </Typography>
          <DataTable
            columns={PRODUCTS}
            rows={view ? [...view.products].sort((a, b) => b.p95Seconds - a.p95Seconds) : null}
            getRowKey={(p) => `${p.team}/${p.product}/${p.action}`}
            emptyMessage="No steps this week."
          />
        </CardContent>
      </Card>
    </Stack>
  );
}
