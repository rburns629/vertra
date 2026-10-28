// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import {
  ApiError,
  listAllTeams,
  listExecutions,
  listPendingApprovals,
  type ExecutionSummary,
  type PendingApproval,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { statusFill } from "../statusColor";
import { duration, when } from "../time";

const STATUS_OPTIONS = ["RUNNING", "AWAITING_APPROVAL", "PENDING", "FAILED", "SUCCEEDED", "CANCELLED"];
const PAGE_SIZE = 100;
/** How long typing pauses before the search goes to the server. */
const SEARCH_DELAY_MS = 300;
/** More steps than this show as one bar, not a segment each. */
const MAX_SEGMENTS = 12;
/** The order a run's steps are drawn in: done first, then what's moving. */
const STEP_ORDER = ["SUCCEEDED", "FAILED", "CANCELLED", "RUNNING", "CLAIMED", "AWAITING_APPROVAL"];

type Whose = "all" | "mine" | "approve";

/** What a run was: its template ("app-on-cloud-run · gcp-platform") or a DAG of its teams. */
function what(run: ExecutionSummary): string {
  if (run.template === "cleanup") return `Cleanup · ${run.teams.join(", ")}`;
  if (run.template === "preview") return `Preview · ${run.teams.join(", ")}`;
  if (run.template === "order") return `Order · ${run.teams.join(", ")}`;
  const slash = run.template.indexOf("/");
  if (slash > 0) return `${run.template.slice(slash + 1)} · ${run.template.slice(0, slash)}`;
  return `DAG · ${run.teams.join(", ")}`;
}

function took(run: ExecutionSummary, now: number): string {
  const start = Date.parse(run.createdAt);
  if (run.finishedAt) return duration(Date.parse(run.finishedAt) - start);
  if (run.state === "RUNNING" || run.state === "AWAITING_APPROVAL") return `${duration(now - start)} so far`;
  return "—";
}

/** A run's steps as one segment each, colored by state, and "2 of 4" done. */
function Steps({ steps }: { steps: Record<string, number> }) {
  const theme = useTheme();
  const total = Object.values(steps).reduce((a, b) => a + b, 0);
  if (total === 0) return <Typography sx={{ fontSize: 13, color: "text.secondary" }}>—</Typography>;
  const done = steps["SUCCEEDED"] ?? 0;
  const ordered = [...STEP_ORDER, ...Object.keys(steps).filter((s) => !STEP_ORDER.includes(s))];
  const segments = ordered.flatMap((state) => Array.from({ length: steps[state] ?? 0 }, () => state));
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <Box aria-hidden="true" sx={{ display: "flex", gap: "3px", width: total > MAX_SEGMENTS ? 80 : undefined }}>
        {total > MAX_SEGMENTS
          ? ordered
              .filter((state) => steps[state])
              .map((state) => (
                <Box key={state} sx={{ height: 8, borderRadius: "2px", flex: steps[state], bgcolor: statusFill(theme, state) }} />
              ))
          : segments.map((state, i) => (
              <Box key={i} sx={{ width: 14, height: 8, borderRadius: "2px", bgcolor: statusFill(theme, state), opacity: state === "PENDING" || state === "READY" || state === "BLOCKED" ? 0.45 : 1 }} />
            ))}
      </Box>
      <Typography component="span" sx={{ fontSize: 13, color: "text.primary", whiteSpace: "nowrap" }}>
        {done} of {total}
      </Typography>
    </Box>
  );
}

/**
 * Runs you can see, newest first: from the console's record of who started
 * what (already scoped to the viewer), each with its state and steps from
 * kernel-api in bulk. To approve lists the steps waiting for your team.
 */
export function ExecutionsListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whose, setWhose] = useState<Whose>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [allTeams, setAllTeams] = useState<string[]>([]);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); }, SEARCH_DELAY_MS);
    return () => { clearTimeout(timer); };
  }, [search]);

  // Whose, name and team are filtered on the server; a new filter starts over.
  useEffect(() => {
    if (whose === "approve") return;
    let cancelled = false;
    setExecutions(null);
    listExecutions({ limit: PAGE_SIZE, search: query, team: teamFilter, mine: whose === "mine" })
      .then((page) => {
        if (cancelled) return;
        setExecutions(page.executions);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load the runs.");
      });
    return () => { cancelled = true; };
  }, [query, teamFilter, whose]);

  useEffect(() => {
    listPendingApprovals()
      .then((list) => { setApprovals(list.filter((a) => a.canDecide)); })
      .catch(() => { setApprovals([]); });
  }, []);

  useEffect(() => {
    if (!user?.isAdmin) return;
    listAllTeams()
      .then((teams) => { setAllTeams(teams.map((team) => team.name)); })
      .catch(() => { /* the filter offers the teams on the loaded runs */ });
  }, [user?.isAdmin]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listExecutions({ limit: PAGE_SIZE, cursor: nextCursor, search: query, team: teamFilter, mine: whose === "mine" });
      setExecutions((loaded) => [...(loaded ?? []), ...page.executions]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load more runs.");
    } finally {
      setLoadingMore(false);
    }
  }

  // State comes from kernel-api per page, so it's filtered here, over what's loaded.
  const filtered = useMemo(() => {
    if (!executions) return null;
    return statusFilter ? executions.filter((e) => e.state === statusFilter) : executions;
  }, [executions, statusFilter]);

  const teamOptions = user?.isAdmin
    ? Array.from(new Set([...allTeams, ...(executions?.flatMap((e) => e.teams) ?? [])])).sort()
    : (user?.teamNames ?? []);
  const open = (id: string) => { navigate(`/runs/${encodeURIComponent(id)}`); };

  const columns: DataTableColumn<ExecutionSummary>[] = [
    {
      key: "run",
      header: "Run",
      render: (e) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
          <Link component={RouterLink} to={`/runs/${encodeURIComponent(e.executionId)}`} underline="hover" sx={{ fontWeight: 500 }} onClick={(event) => { event.stopPropagation(); }}>
            {e.name}
          </Link>
          <Typography component="span" sx={{ fontSize: 13, color: "text.secondary", overflowWrap: "anywhere" }}>
            {what(e)}
          </Typography>
        </Box>
      ),
    },
    { key: "state", header: "State", render: (e) => (e.state ? <StatusBadge status={e.state} /> : "—") },
    { key: "steps", header: "Steps", hideBelow: "sm", render: (e) => <Steps steps={e.steps} /> },
    { key: "started", header: "Started", hideBelow: "md", render: (e) => <Box sx={{ whiteSpace: "nowrap" }}>{when(e.createdAt)}</Box> },
    { key: "took", header: "Took", hideBelow: "md", render: (e) => <Box sx={{ whiteSpace: "nowrap" }}>{took(e, now)}</Box> },
  ];

  const approvalColumns: DataTableColumn<PendingApproval>[] = [
    {
      key: "run",
      header: "Run",
      render: (a) => (
        <Link component={RouterLink} to={`/runs/${encodeURIComponent(a.executionId)}`} underline="hover" sx={{ fontWeight: 500 }} onClick={(event) => { event.stopPropagation(); }}>
          {a.executionName}
        </Link>
      ),
    },
    { key: "step", header: "Step", render: (a) => `${a.taskId} · ${a.team}` },
    { key: "by", header: "Asked by", hideBelow: "sm", render: (a) => a.requestedBy },
    { key: "since", header: "Waiting since", hideBelow: "md", render: (a) => (a.awaitingSince ? when(a.awaitingSince) : "—") },
  ];

  const toApprove = approvals?.length ?? 0;

  return (
    <Box>
      <PageHeader
        title="Runs"
        subtitle="Runs you started, your teams', and any that ran your teams' steps."
        action={
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button variant="outlined" onClick={() => { navigate("/runs/made"); }}>
              What runs made
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => { navigate("/runs/submit"); }}>
              Submit new
            </Button>
          </Box>
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {toApprove > 0 && whose !== "approve" && (
        <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => { setWhose("approve"); }}>Review</Button>}>
          {toApprove === 1 ? "A step waits" : `${String(toApprove)} steps wait`} for your team to approve {toApprove === 1 ? "it" : "them"}.
        </Alert>
      )}

      <Box sx={{ display: "flex", gap: 1.25, mb: 2, flexWrap: "wrap", alignItems: "center" }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={whose}
          onChange={(_, value: Whose | null) => { if (value) setWhose(value); }}
          aria-label="Whose runs"
          sx={{ bgcolor: "background.paper", "& .MuiToggleButton-root": { px: 1.75, minHeight: 40 } }}
        >
          <ToggleButton value="mine">Mine</ToggleButton>
          <ToggleButton value="all">All I can see</ToggleButton>
          <ToggleButton value="approve">To approve{toApprove > 0 ? ` (${String(toApprove)})` : ""}</ToggleButton>
        </ToggleButtonGroup>
        {whose !== "approve" && (
          <>
            <FormControl size="small" sx={{ minWidth: 160, bgcolor: "background.paper" }}>
              <InputLabel id="team-filter-label">Team</InputLabel>
              <Select labelId="team-filter-label" label="Team" value={teamFilter} onChange={(event) => { setTeamFilter(event.target.value); }}>
                <MenuItem value="">Any team</MenuItem>
                {teamOptions.filter(Boolean).map((team) => (
                  <MenuItem key={team} value={team}>
                    {team}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160, bgcolor: "background.paper" }}>
              <InputLabel id="status-filter-label">State</InputLabel>
              <Select labelId="status-filter-label" label="State" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); }}>
                <MenuItem value="">Any state</MenuItem>
                {STATUS_OPTIONS.map((status) => (
                  <MenuItem key={status} value={status}>
                    <StatusBadge status={status} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              placeholder="Find a run by name"
              slotProps={{ htmlInput: { "aria-label": "Find a run" } }}
              value={search}
              onChange={(event) => { setSearch(event.target.value); }}
              sx={{ flex: "1 1 240px", minWidth: 0, bgcolor: "background.paper" }}
            />
          </>
        )}
      </Box>

      {whose === "approve" ? (
        <DataTable
          columns={approvalColumns}
          rows={approvals}
          getRowKey={(a) => `${a.executionId}/${a.taskId}`}
          onRowClick={(a) => { open(a.executionId); }}
          emptyMessage="Nothing waits for your teams to approve."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(e) => e.executionId}
          onRowClick={(e) => { open(e.executionId); }}
          emptyMessage={
            executions && executions.length > 0
              ? "No runs match these filters."
              : whose === "mine"
                ? "You haven't started a run yet. Find something to run in the Catalog."
                : "No runs you can see yet: they're your own, your teams', and any that used your teams' steps."
          }
        />
      )}
      {whose !== "approve" && nextCursor && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
