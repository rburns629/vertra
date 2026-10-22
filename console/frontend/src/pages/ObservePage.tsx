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
import BlockIcon from "@mui/icons-material/BlockOutlined";
import GppGoodIcon from "@mui/icons-material/GppGoodOutlined";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import ReportIcon from "@mui/icons-material/ReportProblemOutlined";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { MetricCard } from "../components/MetricCard";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { ApiError, getSecurity, type SecurityView } from "../api";

type TabId = "security";
const TABS: [TabId, string][] = [["security", "Security checks"]];

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
