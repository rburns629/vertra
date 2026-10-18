// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import AddIcon from "@mui/icons-material/Add";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ApiError, listAllTeams, listExecutions, type ExecutionSummary } from "../api";
import { useAuth } from "../auth/AuthContext";

const STATUS_OPTIONS = ["SUCCEEDED", "FAILED", "RUNNING", "PENDING", "CANCELLED"];
const PAGE_SIZE = 100;
/** How long typing pauses before the search goes to the server. */
const SEARCH_DELAY_MS = 300;

/**
 * Sourced from console/'s own record of who submitted what (see
 * ../../src/db/schema.ts's submittedExecutions), not from kernel-api
 * directly -- kernel-api has no concept of "which executions can this
 * caller see," so this list is already scoped to the viewer (their teams,
 * or everything if admin) by the time it gets here. `state` per row comes
 * from a second, bulk call to kernel-api (see ../api.ts's
 * ExecutionSummary) -- real per-execution status, not inferred.
 */
export function ExecutionsListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [allTeams, setAllTeams] = useState<string[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  // Name and team are filtered on the server; a new filter starts over.
  useEffect(() => {
    let cancelled = false;
    setExecutions(null);
    listExecutions({ limit: PAGE_SIZE, search: query, team: teamFilter })
      .then((page) => {
        if (cancelled) return;
        setExecutions(page.executions);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load executions.");
      });
    return () => {
      cancelled = true;
    };
  }, [query, teamFilter]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    listAllTeams()
      .then((teams) => {
        setAllTeams(teams.map((team) => team.name));
      })
      .catch(() => {
        // The filter then offers the teams on the loaded executions.
      });
  }, [user?.isAdmin]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listExecutions({ limit: PAGE_SIZE, cursor: nextCursor, search: query, team: teamFilter });
      setExecutions((loaded) => [...(loaded ?? []), ...page.executions]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load more executions.");
    } finally {
      setLoadingMore(false);
    }
  }

  // Status comes from kernel-api per page, so it's filtered here, over
  // what's loaded so far.
  const filtered = useMemo(() => {
    if (!executions) return null;
    return statusFilter ? executions.filter((e) => e.state === statusFilter) : executions;
  }, [executions, statusFilter]);

  const teamOptions = user?.isAdmin
    ? Array.from(new Set([...allTeams, ...(executions?.flatMap((e) => e.teams) ?? [])])).sort()
    : (user?.teamNames ?? []);

  const columns: DataTableColumn<ExecutionSummary>[] = [
    {
      key: "reference",
      header: "Reference",
      render: (e) => (
        <Link
          href={`/executions/${encodeURIComponent(e.executionId)}`}
          onClick={(event) => {
            event.preventDefault();
            navigate(`/executions/${encodeURIComponent(e.executionId)}`);
          }}
        >
          {e.name}
        </Link>
      ),
    },
    {
      key: "teams",
      header: "Team",
      hideBelow: "sm",
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
      hideBelow: "md",
      render: (e) => new Date(e.createdAt).toLocaleString(),
    },
  ];

  return (
    <Box>
      <PageHeader
        title="Executions"
        subtitle="View and troubleshoot DAG runs across the platform."
        action={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => { navigate("/executions/submit"); }}
          >
            Submit new
          </Button>
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: "flex", gap: 1.5, mb: 2, flexWrap: "wrap" }}>
        <TextField
          size="small"
          placeholder="Search executions"
          slotProps={{ htmlInput: { "aria-label": "Search executions" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ minWidth: 220 }}
        />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="team-filter-label">Team</InputLabel>
          <Select
            labelId="team-filter-label"
            label="Team"
            value={teamFilter}
            onChange={(event) => { setTeamFilter(event.target.value); }}
          >
            <MenuItem value="">All teams</MenuItem>
            {teamOptions
              .filter((team): team is string => Boolean(team))
              .map((team) => (
                <MenuItem key={team} value={team}>
                  {team}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="status-filter-label">Status</InputLabel>
          <Select
            labelId="status-filter-label"
            label="Status"
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value); }}
          >
            <MenuItem value="">All statuses</MenuItem>
            {STATUS_OPTIONS.map((status) => (
              <MenuItem key={status} value={status}>
                {status.charAt(0) + status.slice(1).toLowerCase()}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(e) => e.executionId}
        onRowClick={(e) => { navigate(`/executions/${encodeURIComponent(e.executionId)}`); }}
        emptyMessage={
          executions && executions.length > 0
            ? "No executions match these filters."
            : `No executions visible yet${!user?.isAdmin ? " -- only ones belonging to your teams show up here" : ""}.`
        }
      />
      {nextCursor && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
