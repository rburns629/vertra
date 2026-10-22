// SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DownloadIcon from "@mui/icons-material/Download";
import type { ExecutionEvent, TaskLogs } from "../../api";

type Entry = { kind: "event"; eventType: string; createdAt: string } | { kind: "output"; line: string };

const TERMINAL_EVENT_TYPES = new Set(["TASK_SUCCEEDED", "TASK_FAILED"]);

/**
 * A step's scheduler milestones (TASK_CLAIMED, TASK_STARTED, ...) and its
 * captured output as one feed. Output is captured once the step finishes,
 * so it belongs just before its terminal event; a step still running has
 * only its events so far.
 */
function feedOf(logs: TaskLogs | undefined, events: ExecutionEvent[]): Entry[] {
  const eventEntries: Entry[] = events.map((e) => ({ kind: "event", eventType: e.eventType, createdAt: e.createdAt }));
  const output: Entry[] = (logs?.lines ?? []).map((line) => ({ kind: "output", line }));
  if (logs && logs.hidden > 0) {
    // Only INFO lines reach people outside the step's team.
    output.push({
      kind: "output",
      line: `(${String(logs.hidden)} more line${logs.hidden === 1 ? "" : "s"}, debug, warnings and errors: only ${logs.visibleTo} sees them)`,
    });
  }
  const last = events.at(-1);
  return output.length > 0 && last && TERMINAL_EVENT_TYPES.has(last.eventType)
    ? [...eventEntries.slice(0, -1), ...output, ...eventEntries.slice(-1)]
    : [...eventEntries, ...output];
}

// On the theme's code surface; see theme.ts for each one's contrast there.
function eventColor(eventType: string): string {
  if (eventType === "TASK_SUCCEEDED") return "success.light";
  if (eventType === "TASK_FAILED") return "error.light";
  return "code.accent";
}

export function StepLogs({
  executionId,
  taskId,
  logs,
  events,
}: {
  executionId: string;
  taskId: string;
  logs: TaskLogs | undefined;
  events: ExecutionEvent[];
}) {
  const [search, setSearch] = useState("");
  const feed = useMemo(() => feedOf(logs, events), [logs, events]);
  const query = search.trim().toLowerCase();
  const shown = query ? feed.filter((e) => (e.kind === "event" ? e.eventType : e.line).toLowerCase().includes(query)) : feed;

  function download(): void {
    const text = feed.map((e) => (e.kind === "event" ? `${e.createdAt} ${e.eventType}` : e.line)).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${taskId}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          size="small"
          placeholder="Search this step's output"
          slotProps={{ htmlInput: { "aria-label": "Search this step's output" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ flex: "1 1 220px" }}
        />
        <Button size="small" startIcon={<DownloadIcon />} onClick={download} disabled={feed.length === 0}>
          Download
        </Button>
        <Button size="small" component={RouterLink} to={`/observe?tab=logs&run=${encodeURIComponent(executionId)}`}>
          Search in Observe
        </Button>
      </Box>
      <Box
        tabIndex={0}
        role="region"
        aria-label={`${taskId} output`}
        sx={{ maxHeight: 420, overflowY: "auto", p: 2, borderRadius: 2, bgcolor: "code.background", color: "code.text", fontFamily: "fontFamilyMono", fontSize: 13 }}
      >
        {shown.length === 0 && (
          <Typography variant="body2" sx={{ color: "code.textMuted" }}>
            {feed.length === 0 ? "Nothing yet." : "Nothing matches."}
          </Typography>
        )}
        {shown.map((entry, i) =>
          entry.kind === "event" ? (
            // The feed has no stable ids, and is rebuilt each render.
            <Box key={i} sx={{ mb: 0.25 }}>
              <Box component="span" sx={{ color: "code.textMuted" }}>
                {new Date(entry.createdAt).toLocaleTimeString()}{" "}
              </Box>
              <Box component="span" sx={{ color: eventColor(entry.eventType), fontWeight: 600 }}>
                {entry.eventType}
              </Box>
            </Box>
          ) : (
            <Box key={i} sx={{ whiteSpace: "pre-wrap", mb: 0.25, pl: 2 }}>
              {entry.line}
            </Box>
          ),
        )}
      </Box>
    </Box>
  );
}
