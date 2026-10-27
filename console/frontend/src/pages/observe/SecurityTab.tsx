// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import BlockIcon from "@mui/icons-material/BlockOutlined";
import GppGoodIcon from "@mui/icons-material/GppGoodOutlined";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import ReportIcon from "@mui/icons-material/ReportProblemOutlined";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Pill, type PillTone } from "../../components/Pill";
import { MetricCard } from "../../components/MetricCard";
import { Mono } from "../../components/Mono";
import { ApiError, getImageSbom, getSecurity, type SecurityView } from "../../api";
import { useAuth } from "../../auth/AuthContext";

const STATE: Record<string, { label: string; tone: PillTone }> = {
  enforced: { label: "Enforced", tone: "success" },
  off: { label: "Off here", tone: "warning" },
  not_yet: { label: "Not yet", tone: "neutral" },
};

const SCAN: Record<string, { label: string; tone: PillTone }> = {
  passed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  error: { label: "Couldn't scan", tone: "warning" },
  pending: { label: "Scanning", tone: "neutral" },
  unscanned: { label: "Not scanned", tone: "neutral" },
};

/** Who refused it: the refusals filter's choices. */
const SOURCES: [string, string][] = [
  ["", "All"],
  ["step", "Cluster"],
  ["catalog", "Catalog"],
  ["gateway", "Gateway"],
];

const stateOf = (state: string) => STATE[state] ?? { label: "Not yet", tone: "neutral" as const };
const scanOf = (scan: string) => SCAN[scan] ?? { label: "Not scanned", tone: "neutral" as const };

type Refusal = SecurityView["refusals"][number];
type Image = SecurityView["images"][number];

const REFUSALS: DataTableColumn<Refusal>[] = [
  { key: "when", header: "When", render: (r) => (r.at ? new Date(r.at).toLocaleString() : "—"), hideBelow: "sm" },
  {
    key: "what",
    header: "What",
    render: (r) => (
      <>
        {r.executionId ? (
          <Link component={RouterLink} to={`/runs/${r.executionId}`}>
            {r.what}
          </Link>
        ) : (
          r.what
        )}
        {r.source === "gateway" && `, ${r.count.toLocaleString()} call${r.count === 1 ? "" : "s"}`}
      </>
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
        <Pill tone={scanOf(i.scan).tone}>{scanOf(i.scan).label}</Pill>
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
  { key: "sbom", header: "SBOM", render: (i) => <SbomButton image={i.image} product={i.product} />, hideBelow: "md" },
];

/** Downloads an image's SBOM, as catalog CI attached it; says so when there's none. */
function SbomButton({ image, product }: { image: string; product: string }) {
  const [state, setState] = useState<"idle" | "busy" | "none" | "failed">("idle");
  async function download(): Promise<void> {
    setState("busy");
    try {
      const sbom = await getImageSbom(image);
      const url = URL.createObjectURL(new Blob([sbom], { type: "application/vnd.cyclonedx+json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${product}.cdx.json`;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch (err) {
      setState(err instanceof ApiError && err.code === "NO_SBOM" ? "none" : "failed");
    }
  }
  if (state === "none") return <Typography variant="caption" color="text.secondary">None attached</Typography>;
  return (
    <Button size="small" disabled={state === "busy"} onClick={() => void download()}>
      {state === "failed" ? "Try again" : "Download"}
    </Button>
  );
}

export function SecurityTab() {
  const { user } = useAuth();
  const [view, setView] = useState<SecurityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState("");

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
                  <Pill tone={stateOf(c.state).tone}>{stateOf(c.state).label}</Pill>
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
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Steps the cluster wouldn&apos;t start, catalog releases the console couldn&apos;t apply, and calls the gateway stopped (your
            team&apos;s APIs, and your team&apos;s calls). A run is linked when you may see it.
          </Typography>
          <Box role="group" aria-label="Refused by" sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1.5 }}>
            {SOURCES.map(([id, label]) => (
              <Chip
                key={id || "all"}
                label={label}
                clickable
                aria-pressed={source === id}
                color={source === id ? "primary" : "default"}
                variant={source === id ? "filled" : "outlined"}
                onClick={() => { setSource(id); }}
              />
            ))}
          </Box>
          <DataTable
            columns={REFUSALS}
            rows={view ? view.refusals.filter((r) => !source || r.source === source) : null}
            getRowKey={(r) => `${r.source}/${r.at ?? ""}/${r.what}/${r.code}`}
            emptyMessage="Nothing refused this week."
          />
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            Every image allowed to run here
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Pinned to a digest, scanned before it may run, and rescanned against new advisories while it&apos;s in use.
            {user?.isAdmin && (
              <>
                {" "}
                <Link component={RouterLink} to="/admin?tab=scans">
                  Every scan, its findings, and accepting one
                </Link>
                .
              </>
            )}
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
