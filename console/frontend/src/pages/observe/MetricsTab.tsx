// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import HourglassIcon from "@mui/icons-material/HourglassEmptyOutlined";
import PlayCircleIcon from "@mui/icons-material/PlayCircleOutlined";
import ErrorIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { MetricCard } from "../../components/MetricCard";
import { Mono } from "../../components/Mono";
import { ApiError, getMetrics, type MetricsView } from "../../api";

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

export function MetricsTab() {
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
