// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import BlockIcon from "@mui/icons-material/BlockOutlined";
import CallMadeIcon from "@mui/icons-material/CallMade";
import CallReceivedIcon from "@mui/icons-material/CallReceived";
import ErrorIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { MetricCard } from "../components/MetricCard";
import { Mono } from "../components/Mono";
import { ApiError, getApiTraffic, type ApiTraffic as Traffic } from "../api";

const shown = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

type EndpointRow = Traffic["endpoints"][number];
type BlockedRow = Traffic["blocked"][number];
type TeamRow = Traffic["teams"][number];

const ENDPOINTS: DataTableColumn<EndpointRow>[] = [
  { key: "endpoint", header: "Endpoint", render: (e) => <Mono>{e.endpoint}</Mono> },
  { key: "requests", header: "Requests", render: (e) => e.requests.toLocaleString(), align: "right" },
  { key: "invalid", header: "Stopped: didn't fit", render: (e) => e.invalid.toLocaleString(), align: "right", hideBelow: "sm" },
  { key: "4xx", header: "Backend 4xx", render: (e) => e.backend4xx.toLocaleString(), align: "right", hideBelow: "md" },
  { key: "5xx", header: "Backend 5xx", render: (e) => e.backend5xx.toLocaleString(), align: "right", hideBelow: "sm" },
  { key: "ms", header: "Backend, average", render: (e) => (e.averageMs ? `${String(e.averageMs)} ms` : "—"), align: "right", hideBelow: "md" },
];

const BLOCKED: DataTableColumn<BlockedRow>[] = [
  { key: "request", header: "Request", render: (b) => <Mono>{b.request}</Mono> },
  { key: "count", header: "Count", render: (b) => b.count.toLocaleString(), align: "right" },
  { key: "from", header: "From", render: (b) => b.teams.join(", ") || "—", hideBelow: "sm" },
  { key: "last", header: "Last", render: (b) => (b.last ? new Date(b.last).toLocaleString() : "—"), hideBelow: "md" },
];

const TEAMS: DataTableColumn<TeamRow>[] = [
  { key: "team", header: "Calling team", render: (t) => t.team || "(not signed in)" },
  { key: "requests", header: "Requests", render: (t) => t.requests.toLocaleString(), align: "right" },
  {
    key: "peak",
    header: "Busiest minute",
    render: (t) => (t.limitPerMinute ? `${String(t.peakPerMinute)} of ${String(t.limitPerMinute)}` : String(t.peakPerMinute)),
    align: "right",
  },
];

/**
 * An API's traffic (ApiService.GetApiTraffic), for its own team: what
 * callers sent, what the gateway stopped, and what the backend answered.
 * Bodies are never recorded; nor who called beyond their team.
 */
export function ApiTraffic({ team, name }: { team: string; name: string }) {
  const [hours, setHours] = useState(24);
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTraffic(null);
    getApiTraffic(team, name, hours)
      .then((t) => {
        if (!cancelled) setTraffic(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load its traffic.");
      });
    return () => {
      cancelled = true;
    };
  }, [team, name, hours]);

  return (
    <Card variant="outlined" sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1, mb: 1 }}>
          <Typography variant="h6" component="h2">
            Traffic
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={hours}
            onChange={(_e, value: number | null) => {
              if (value) setHours(value);
            }}
          >
            <ToggleButton value={24}>Last 24 hours</ToggleButton>
            <ToggleButton value={168}>Last 7 days</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          What callers sent, what the gateway stopped, and what your backend answered. Bodies are never recorded; callers only by team.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" }, mb: 3 }}>
          <MetricCard label="Requests" value={shown(traffic?.requests)} icon={<CallReceivedIcon fontSize="small" />} />
          <MetricCard label="Forwarded" value={shown(traffic?.forwarded)} icon={<CallMadeIcon fontSize="small" />} />
          <MetricCard label="Stopped at the gateway" value={shown(traffic?.stopped)} icon={<BlockIcon fontSize="small" />} />
          <MetricCard label="Backend errors" value={shown(traffic?.backendErrors)} icon={<ErrorIcon fontSize="small" />} />
        </Box>
        <Typography variant="subtitle1" component="h3">
          By endpoint
        </Typography>
        <DataTable columns={ENDPOINTS} rows={traffic?.endpoints ?? null} getRowKey={(e) => e.endpoint} emptyMessage="No requests yet." />
        <Typography variant="subtitle1" component="h3" sx={{ mt: 3 }}>
          Blocked: not in the spec
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Requests for paths or methods your OpenAPI file doesn&apos;t describe. They got 404 from the gateway and never reached your backend.
          A caller that keeps sending one may be relying on an endpoint you never published.
        </Typography>
        <DataTable columns={BLOCKED} rows={traffic?.blocked ?? null} getRowKey={(b) => b.request} emptyMessage="Nothing blocked." />
        <Typography variant="subtitle1" component="h3" sx={{ mt: 3 }}>
          By calling team
        </Typography>
        <DataTable columns={TEAMS} rows={traffic?.teams ?? null} getRowKey={(t) => t.team || "-"} emptyMessage="No callers yet." />
      </CardContent>
    </Card>
  );
}
