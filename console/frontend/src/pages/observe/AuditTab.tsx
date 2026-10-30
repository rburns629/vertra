// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import { useAuth } from "../../auth/AuthContext";
import { Pill, type PillTone } from "../../components/Pill";
import { when } from "../../time";
import { ApiError, listAllTeams, listAudit, type AuditEntryView, getAuditCopy, type AuditCopy } from "../../api";

/** "vertra.console.v1.SecretService/PutSecret" → "Put secret", "catalog-sync" → "Catalog sync". */
function actionName(route: string): { action: string; service: string } {
  const [service = "", method] = route.replace(/^vertra\.console\.v1\./, "").split("/");
  const words = (method ?? service).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ").toLowerCase();
  return { action: words.charAt(0).toUpperCase() + words.slice(1), service: method ? service.replace(/Service$/, "") : "" };
}

function outcome(status: number): { label: string; tone: PillTone } {
  if (status === 207) return { label: "Done, with problems", tone: "warning" };
  if (status < 400) return { label: "Done", tone: "success" };
  if (status === 401 || status === 403) return { label: "Refused", tone: "error" };
  if (status < 500) return { label: "Rejected", tone: "warning" };
  return { label: "Failed", tone: "error" };
}

/** Whether the log's hash chain held, from its write-once copy; nothing when there's no copy. */
function ChainStatus() {
  const [copy, setCopy] = useState<AuditCopy | null>(null);
  useEffect(() => {
    // Display only: without it, the line just isn't shown.
    getAuditCopy().then(setCopy).catch(() => undefined);
  }, []);
  if (!copy?.enabled) return null;
  if (copy.differsAt > 0) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {copy.compareProblem || `Entry ${String(copy.differsAt)} in the database differs from its write-once copy.`}
      </Alert>
    );
  }
  if (copy.brokenAt > 0) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        The log&apos;s chain breaks at entry {copy.brokenAt}: it was changed, or one before it removed or added, after it was
        written. Its copy stops there.
      </Alert>
    );
  }
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 2 }}>
      <Pill tone="success">Chain intact</Pill>
      <Typography variant="body2" color="text.secondary">
        {copy.checkedAt ? `checked ${when(copy.checkedAt)}` : "not checked yet"}
        {copy.copiedAt ? ` · copied to write-once storage ${when(copy.copiedAt)}` : ""}
        {copy.comparedAt ? ` · compared with the copy ${when(copy.comparedAt)}` : ""}
      </Typography>
    </Box>
  );
}

function targetText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const AUDIT: DataTableColumn<AuditEntryView>[] = [
  { key: "when", header: "When", render: (e) => (e.at ? new Date(e.at).toLocaleString() : "—"), hideBelow: "sm" },
  {
    key: "who",
    header: "Who",
    render: (e) => (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="body2">{e.actorEmail ?? "The console"}</Typography>
        {e.actorIsBot && <Pill tone="neutral">bot</Pill>}
      </Stack>
    ),
  },
  {
    key: "what",
    header: "What",
    render: (e) => {
      const { action, service } = actionName(e.route);
      return (
        <Box>
          <Typography variant="body2">{action}</Typography>
          {service && (
            <Typography variant="caption" color="text.secondary">
              {service}
            </Typography>
          )}
        </Box>
      );
    },
  },
  {
    key: "target",
    header: "On",
    render: (e) => (
      <Stack spacing={0.25}>
        {Object.entries(e.target).map(([key, value]) => (
          <Typography key={key} variant="caption" sx={{ overflowWrap: "anywhere" }}>
            <Box component="span" sx={{ color: "text.secondary" }}>
              {key}:
            </Box>{" "}
            {key === "executionId" && typeof value === "string" ? (
              <Link component={RouterLink} to={`/runs/${value}`}>
                <Mono>{value.slice(0, 8)}</Mono>
              </Link>
            ) : (
              targetText(value)
            )}
          </Typography>
        ))}
      </Stack>
    ),
    hideBelow: "md",
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (e) => (
      <Pill tone={outcome(e.status).tone} title={`HTTP ${String(e.status)}`}>
        {outcome(e.status).label}
      </Pill>
    ),
  },
];

export function AuditTab() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<string[]>([]);
  const [team, setTeam] = useState("");
  const [mine, setMine] = useState(false);
  const [refusedOnly, setRefusedOnly] = useState(false);
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [nextBefore, setNextBefore] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!user.isAdmin) {
      setTeams(user.teamNames);
      return;
    }
    listAllTeams()
      .then((all) => {
        setTeams(all.map((t) => t.name).sort());
      })
      .catch(() => {
        setTeams([]);
      });
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    listAudit({ team, mine, refusedOnly })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setNextBefore(page.nextBefore);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load the audit log.");
      });
    return () => {
      cancelled = true;
    };
  }, [team, mine, refusedOnly]);

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const page = await listAudit({ before: nextBefore, team, mine, refusedOnly });
      setEntries((shown) => [...(shown ?? []), ...page.entries]);
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load more.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" component="h2">
          Who changed what
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {user?.isAdmin
            ? "Every change anyone asked for, allowed or refused. Secrets' values, passwords and tokens are never recorded."
            : "Your own changes, and every change to your teams and their runs, by anyone. Secrets' values, passwords and tokens are never recorded."}
        </Typography>
        <ChainStatus />
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center", mb: 2 }}>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="audit-team-label">Team</InputLabel>
            <Select
              labelId="audit-team-label"
              label="Team"
              value={team}
              onChange={(event) => {
                setTeam(event.target.value);
              }}
            >
              <MenuItem value="">{user?.isAdmin ? "Everything" : "All you can see"}</MenuItem>
              {teams.map((name) => (
                <MenuItem key={name} value={name}>
                  {name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Switch
                checked={mine}
                onChange={(event) => {
                  setMine(event.target.checked);
                }}
              />
            }
            label="Only mine"
          />
          <FormControlLabel
            control={
              <Switch
                checked={refusedOnly}
                onChange={(event) => {
                  setRefusedOnly(event.target.checked);
                }}
              />
            }
            label="Only refused or failed"
          />
        </Box>
        <DataTable columns={AUDIT} rows={entries} getRowKey={(e) => e.id} emptyMessage="Nothing recorded that you can see." />
        {nextBefore && (
          <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
            <Button onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
