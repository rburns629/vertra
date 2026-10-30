// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { Schedule } from "../../api";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { useAuth } from "../../auth/AuthContext";
import { describeCron, EditScheduleDialog } from "../catalog/ScheduleDialog";

/**
 * Your teams' schedules, together: what each runs, when, as which bot, how
 * its last start went. A team's maintainers edit one here; pausing,
 * resuming and deleting one stays on its team's page (Schedules).
 */
export function RunsSchedules({ schedules, onSaved }: { schedules: Schedule[] | null; onSaved: (saved: Schedule) => void }) {
  const maintains = useAuth().user?.maintainerOf ?? [];
  const [editing, setEditing] = useState<Schedule | null>(null);
  const columns: DataTableColumn<Schedule>[] = [
    {
      key: "name",
      header: "Schedule",
      render: (s) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
          <Typography component="span" sx={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>
            {s.name}
          </Typography>
          <Typography component="span" sx={{ fontSize: 13, color: "text.secondary", overflowWrap: "anywhere" }}>
            {s.kind === "template" ? `${s.runnableName} by ${s.runnableTeam}` : s.runnableName}
          </Typography>
        </Box>
      ),
    },
    {
      key: "team",
      header: "Team",
      hideBelow: "sm",
      render: (s) => (
        <Link component={RouterLink} to={`/teams/${encodeURIComponent(s.team)}?tab=schedules`}>
          {s.team}
        </Link>
      ),
    },
    {
      key: "when",
      header: "When",
      render: (s) => (
        <Box>
          <Typography variant="body2">{describeCron(s.cron)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {s.timeZone}
            {s.nextRunAt ? ` · next ${when(s.nextRunAt)}` : s.enabled ? " · never again" : ""}
          </Typography>
        </Box>
      ),
    },
    { key: "bot", header: "Runs as", hideBelow: "md", render: (s) => <Box sx={{ overflowWrap: "anywhere" }}>{s.botEmail}</Box> },
    {
      key: "last",
      header: "Last run",
      hideBelow: "md",
      render: (s) =>
        s.lastError ? (
          <Typography variant="caption" color="error">
            {s.lastError}
          </Typography>
        ) : s.lastExecutionId ? (
          <Link component={RouterLink} to={`/runs/${s.lastExecutionId}`} variant="body2">
            {s.lastRunAt ? when(s.lastRunAt) : "its run"}
          </Link>
        ) : (
          "—"
        ),
    },
    { key: "on", header: "State", render: (s) => (s.enabled ? <Pill tone="success">On</Pill> : <Pill tone="neutral">Paused</Pill>) },
    {
      key: "edit",
      header: "",
      align: "right",
      render: (s) =>
        maintains.includes(s.team) && (
          <Button size="small" aria-label={`Edit ${s.name}`} onClick={() => { setEditing(s); }}>
            Edit
          </Button>
        ),
    },
  ];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 820 }}>
        Runs your teams start on a timetable, each as one of their bots. Make one from a template&apos;s or action&apos;s form in the{" "}
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        (Schedule…); pause or delete one on its team&apos;s page.
      </Typography>
      <Card>
        <DataTable columns={columns} rows={schedules} getRowKey={(s) => s.id} emptyMessage="None of your teams has a schedule yet." />
      </Card>
      {editing && (
        <EditScheduleDialog
          schedule={editing}
          onClose={() => { setEditing(null); }}
          onSaved={(saved) => {
            setEditing(null);
            onSaved(saved);
          }}
        />
      )}
    </Box>
  );
}
