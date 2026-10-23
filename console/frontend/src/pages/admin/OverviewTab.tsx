// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { ApiError, getAuditCopy, getPolicySync, syncPolicies, type AuditCopy, type PolicySync } from "../../api";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { CatalogCard } from "./CatalogCard";
import { ImageSourcesCard } from "./ImageSourcesCard";
import { FirstRunChecklist, InstallCard } from "./InstallCards";

/** What each policy holds, as people say it. */
const POLICY: Record<string, string> = {
  identityPolicy: "Products, and the identities and secrets each may use",
  imagePolicy: "Where images may come from",
  scanPolicy: "Images that failed their scan",
  teamNetworkPolicies: "What each team's steps may reach in the cluster",
};

function Panel({ title, status, children }: { title: string; status?: ReactNode; children: ReactNode }) {
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {status}
      </Box>
      {children}
    </Card>
  );
}

/** The cluster's admission policies, which the console writes and the cluster enforces. */
function PoliciesCard() {
  const [policies, setPolicies] = useState<PolicySync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPolicySync()
      .then(setPolicies)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't read the policies."); });
  }, []);

  async function sync(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPolicies(await syncPolicies());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't write them.");
    } finally {
      setBusy(false);
    }
  }

  const applying = (policies ?? []).filter((p) => p.applies);
  const failing = applying.filter((p) => !p.ok);
  return (
    <Panel
      title="Cluster policies"
      status={policies && (failing.length > 0 ? <Pill tone="error">{failing.length} not written</Pill> : <Pill tone="success">In sync</Pill>)}
    >
      <Typography variant="body2" color="text.secondary">
        The cluster refuses any step these don&apos;t allow, whatever the console says. The console writes them when products,
        secrets or image sources change, and at startup.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {policies && applying.length === 0 && <Typography variant="body2">None written since the console started.</Typography>}
      {applying.map((p) => (
        <Box key={p.name} sx={{ display: "flex", justifyContent: "space-between", gap: 2, borderTop: 1, borderColor: "divider", pt: 1.25 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2">{POLICY[p.name] ?? p.name}</Typography>
            {p.error && (
              <Typography variant="caption" color="error.main" sx={{ overflowWrap: "anywhere" }}>
                {p.error}
              </Typography>
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
            {p.ok ? (p.at ? `written ${when(p.at)}` : "written") : "failed"}
          </Typography>
        </Box>
      ))}
      <Box>
        <Button variant="outlined" disabled={busy} onClick={() => void sync()}>
          {busy ? "Writing…" : "Write them again"}
        </Button>
      </Box>
    </Panel>
  );
}

/** The audit log's write-once copy: how far it has gone, and whether its chain held. */
function AuditCopyCard() {
  const [copy, setCopy] = useState<AuditCopy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuditCopy()
      .then(setCopy)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't read the audit copy."); });
  }, []);

  const status = !copy
    ? null
    : !copy.enabled
      ? <Pill tone="neutral">Off</Pill>
      : copy.brokenAt > 0
        ? <Pill tone="error">Chain broken</Pill>
        : copy.problem
          ? <Pill tone="warning">Not copying</Pill>
          : <Pill tone="success">Intact</Pill>;

  return (
    <Panel title="The audit log's copy" status={status}>
      {error && <Alert severity="error">{error}</Alert>}
      {copy && !copy.enabled && (
        <Typography variant="body2" color="text.secondary">
          The audit log is in the console&apos;s database only. Its entries are hash-chained, but nothing checks the chain until
          they&apos;re copied to a bucket that refuses deletes: <Box component="span" sx={{ fontFamily: "fontFamilyMono" }}>audit.export</Box> in
          vertra.yaml (gcp, aws).
        </Typography>
      )}
      {copy?.enabled && (
        <>
          {copy.brokenAt > 0 && (
            <Alert severity="error">
              The chain breaks at entry {copy.brokenAt}: it was changed, or one before it was removed or added, after it was
              written. Nothing from there on is copied.
            </Alert>
          )}
          {copy.problem && copy.brokenAt === 0 && <Alert severity="warning">{copy.problem}</Alert>}
          <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 2, rowGap: 0.75 }}>
            <Typography component="dt" variant="body2" color="text.secondary">
              Copied to
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, fontFamily: "fontFamilyMono", overflowWrap: "anywhere" }}>
              {copy.destination || "—"}
            </Typography>
            <Typography component="dt" variant="body2" color="text.secondary">
              Last copy
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>
              {copy.copiedAt ? `${when(copy.copiedAt)}, through entry ${String(copy.copiedThrough)}` : "not yet"}
            </Typography>
            <Typography component="dt" variant="body2" color="text.secondary">
              Waiting
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>
              {copy.waiting.toLocaleString()} entries
            </Typography>
            <Typography component="dt" variant="body2" color="text.secondary">
              Chain checked
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>
              {copy.checkedAt ? when(copy.checkedAt) : "not yet"}
            </Typography>
          </Box>
        </>
      )}
      <Link component={RouterLink} to="/observe?tab=audit" variant="body2">
        Read the audit log in Observe →
      </Link>
    </Panel>
  );
}

/** This install at a glance: where its teams and products come from, what the cluster enforces, and its audit trail. */
export function OverviewTab() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <FirstRunChecklist />
      <InstallCard />
      <CatalogCard />
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, alignItems: "start" }}>
        <PoliciesCard />
        <AuditCopyCard />
      </Box>
      <ImageSourcesCard />
      <Typography variant="body2" color="text.secondary">
        Every image allowed to run here, with its last scan, is on{" "}
        <Link component={RouterLink} to="/observe">
          Observe
        </Link>
        .
      </Typography>
    </Box>
  );
}
