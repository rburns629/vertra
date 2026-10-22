// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import { dump as dumpYaml } from "js-yaml";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Drawer,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CircleIcon from "@mui/icons-material/Circle";
import CloseIcon from "@mui/icons-material/Close";
import DownloadIcon from "@mui/icons-material/Download";
import { Mono } from "../components/Mono";
import { StatusBadge } from "../components/StatusBadge";
import { computeStages } from "../dagLayout";
import {
  ApiError,
  cancelExecution,
  decideApproval,
  rerunExecution,
  retryTask,
  type ExecutionDetail,
  type ExecutionEvent,
  type SubmittedExecutionPayload,
  type TaskLogs,
  type FailureHelp,
  type TaskApproval,
  type TaskAttempt,
  type TaskStatus,
} from "../api";
import { TERMINAL_STATES, useExecutionWatch } from "./useExecutionWatch";

const RUN_BLOCKED_LABELS: Record<NonNullable<ExecutionDetail["runBlocked"]>["error"], string> = {
  TEAM_PURGED: "Team purged",
  TEAM_RETIRED: "Team retired",
  IMAGE_NOT_FOUND: "Image missing",
  IMAGE_NOT_ALLOWED: "Image not allowed",
  IMAGE_POLICY_NOT_CONFIGURED: "No image source configured",
};

// The Tasks grid's sizing, from named constants so a card's width and the
// arrow spacer under it can't drift apart. Three per row from sm up; one
// on a phone, where three cards would each be narrower than a task id.
const CARDS_PER_ROW_WIDE = 3;
const ROW_GAP_PX = 8; // matches the row Box's `gap: 1` (theme spacing 1)
const ARROW_ICON_WIDTH_PX = 24;
function cardWidthCss(cardsPerRow: number): string {
  const arrowsPerRow = cardsPerRow - 1;
  const gapsPerRow = cardsPerRow + arrowsPerRow - 1;
  const nonCardWidthPx = arrowsPerRow * ARROW_ICON_WIDTH_PX + gapsPerRow * ROW_GAP_PX;
  return `calc((100% - ${String(nonCardWidthPx)}px) / ${String(cardsPerRow)})`;
}

/** `null` while a task hasn't started yet; a live-ticking "still running"
 * form while started but not completed; a fixed duration once both real
 * timestamps exist. Never invented -- absent either timestamp, this
 * renders nothing rather than a guess. */
function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const startMs = new Date(startedAt).getTime();
  const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const label = minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
  return completedAt ? label : `${label} (running)`;
}

function TaskNodeCard({
  task,
  busy,
  selected,
  retryBlocked,
  onRetry,
  onDecide,
  onSelect,
  width,
}: {
  task: TaskStatus;
  /** CSS width shared with the snake grid's down-arrow spacer. */
  width: string;
  busy: string | null;
  selected: boolean;
  /** Why a retry would be refused (the page explains it once, up top). */
  retryBlocked: string | null;
  onRetry: (taskId: string) => void;
  onDecide: (taskId: string, approve: boolean, reason: string) => void;
  onSelect: (taskId: string) => void;
}) {
  const duration = formatDuration(task.startedAt, task.completedAt);
  return (
    <Card
      variant="outlined"
      onClick={() => { onSelect(task.taskId); }}
      sx={{
        // Exactly the row's card count fits regardless of the row's
        // actual width (a fixed px width doesn't) -- see the snake-row
        // layout this feeds into. Budgets for a full row's worth of
        // connector arrows even on a shorter row, so card width stays
        // identical whether or not this particular row has arrows next
        // to every card.
        flex: `0 0 ${width}`,
        maxWidth: width,
        p: 1.5,
        cursor: "pointer",
        borderColor: selected ? "primary.main" : undefined,
        borderWidth: selected ? 2 : 1,
        boxShadow: selected ? 1 : 0,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="body2" sx={{ fontFamily: "fontFamilyMono", fontWeight: 600 }}>
          {task.taskId}
        </Typography>
        <StatusBadge status={task.state} />
      </Box>

      {task.dependsOn.length > 0 && (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 1 }}>
          {task.dependsOn.map((dep) => (
            <Chip
              key={dep}
              // Not "← dep" -- that pointed backward regardless of which
              // direction the connector arrows between cards actually
              // flow (snake rows read right-to-left half the time), so it
              // read as contradicting them rather than reinforcing.
              // "from" says the same thing in words, with no direction to
              // get wrong.
              label={`from ${dep}`}
              size="small"
              variant="outlined"
              sx={{ fontFamily: "fontFamilyMono" }}
            />
          ))}
        </Box>
      )}

      <Box sx={{ display: "flex", justifyContent: "space-between", mt: 1 }}>
        <Typography variant="caption" color="text.secondary">
          attempt {task.attemptCount}
        </Typography>
        {duration && (
          <Typography variant="caption" color="text.secondary">
            {duration}
          </Typography>
        )}
      </Box>

      {task.outputs && (
        <Paper
          variant="outlined"
          tabIndex={0}
          role="region"
          aria-label={`${task.taskId} outputs`}
          sx={{
            mt: 1,
            p: 1,
            fontFamily: "fontFamilyMono",
            fontSize: 11,
            bgcolor: "action.hover",
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          {JSON.stringify(task.outputs, null, 2)}
        </Paper>
      )}

      {task.failure && (
        <Alert severity="error" sx={{ mt: 1 }} variant="outlined">
          <strong>{task.failure.code}</strong>: {task.failure.message}
          {!task.failure.retryable && " (not retryable)"}
        </Alert>
      )}

      {task.help && <Help help={task.help} />}

      {task.approval && (
        <Approval
          approval={task.approval}
          awaiting={task.state === "AWAITING_APPROVAL"}
          busy={busy === task.taskId}
          onDecide={(approve, reason) => { onDecide(task.taskId, approve, reason); }}
        />
      )}

      {task.attempts.length > 0 && <Attempts attempts={task.attempts} />}

      {task.state === "FAILED" && (
        <Tooltip title={retryBlocked ?? ""}>
          {/* A disabled button fires no events, so the tooltip needs a wrapper. */}
          <span>
            <Button
              size="small"
              sx={{ mt: 1 }}
              disabled={busy === task.taskId || retryBlocked !== null}
              onClick={(event) => {
                // Retrying isn't selecting -- without this, the click bubbles
                // up to the Card's onSelect and the two actions get conflated.
                event.stopPropagation();
                onRetry(task.taskId);
              }}
            >
              {busy === task.taskId ? "Retrying…" : "Retry"}
            </Button>
          </span>
        </Tooltip>
      )}
    </Card>
  );
}

function MetadataItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Renders `name`/`requestId` plus *one* task's own
 * entry (filtered from `payload.tasks` by id) as YAML -- the same shape
 * a caller would have written by hand to submit just this step, still
 * under `tasks:` as a single-item list since that's the real submission
 * shape (a bare task object on its own was never valid on its own).
 * `taskId: null` falls back to every task (defensive only -- the drawer
 * that calls this never opens without a selection). Fields a task
 * omitted (dependsOn, secretRefs, inputs, timeoutSeconds, maxAttempts all
 * have server-side defaults -- see proto/vertra/kernel/v1) are left
 * out here too, rather than padding the task with its default values --
 * matches what someone would actually have typed, not what kernel-api
 * resolved it to. Re-orders the task's keys into a fixed, readable order
 * (js-yaml dumps plain objects in insertion order) since the stored
 * payload is the raw client JSON and its key order was never guaranteed.
 */
function buildDagYaml(payload: SubmittedExecutionPayload, taskId: string | null): string {
  const tasks = taskId ? payload.tasks.filter((task) => task.id === taskId) : payload.tasks;
  // Without a requestId there's no line for it.
  const requestId = payload.requestId;
  const ordered = {
    name: payload.name,
    ...(requestId ? { requestId } : {}),
    tasks: tasks.map((task) => {
      const entry: Record<string, unknown> = {
        id: task.id,
        image: task.image,
        action: task.action,
      };
      if (task.dependsOn && task.dependsOn.length > 0) entry.dependsOn = task.dependsOn;
      entry.team = task.team;
      if (task.serviceAccount !== undefined) entry.serviceAccount = task.serviceAccount;
      if (task.secretRefs && task.secretRefs.length > 0) entry.secretRefs = task.secretRefs;
      if (task.inputs && Object.keys(task.inputs).length > 0) entry.inputs = task.inputs;
      if (task.timeoutSeconds !== undefined) entry.timeoutSeconds = task.timeoutSeconds;
      if (task.maxAttempts !== undefined) entry.maxAttempts = task.maxAttempts;
      return entry;
    }),
  };
  // lineWidth: -1 -- otherwise js-yaml wraps a long inputs value onto a
  // continuation line, which reads as broken YAML at a glance even though
  // it technically isn't.
  return dumpYaml(ordered, { indent: 2, lineWidth: -1 });
}

/**
 * The submission-shaped payload for whichever task was clicked, opened
 * from the right -- name/requestId (execution-level,
 * so they're the same regardless of which task opened the drawer) plus
 * that one task's own entry, not every task in the DAG.
 */
function TaskPayloadDrawer({
  open,
  payload,
  selectedTaskId,
  onClose,
}: {
  open: boolean;
  payload: SubmittedExecutionPayload | null;
  selectedTaskId: string | null;
  onClose: () => void;
}) {
  const yaml = useMemo(
    () => (payload ? buildDagYaml(payload, selectedTaskId) : ""),
    [payload, selectedTaskId],
  );

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: { xs: "90vw", sm: 480 }, p: 2, display: "flex", flexDirection: "column", height: "100%" }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            DAG payload
          </Typography>
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        {selectedTaskId && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            <Mono>{selectedTaskId}</Mono>'s own submitted definition.
          </Typography>
        )}
        <Paper
          variant="outlined"
          tabIndex={0}
          role="region"
          aria-label="Task definition"
          sx={{
            p: 1.5,
            flex: 1,
            overflow: "auto",
            fontFamily: "fontFamilyMono",
            fontSize: 12.5,
            whiteSpace: "pre",
            bgcolor: "action.hover",
          }}
        >
          {yaml || "This execution predates payload storage, so there's nothing to show here."}
        </Paper>
      </Box>
    </Drawer>
  );
}

type MergedEntry =
  | { kind: "event"; eventType: string; createdAt: string }
  | { kind: "output"; line: string };

interface MergedTaskFeed {
  taskId: string;
  entries: MergedEntry[];
  /** This task's earliest event timestamp, `null` if it has none yet --
   * used only to order task blocks chronologically in the aggregated
   * view; never displayed itself. */
  firstTimestamp: string | null;
}

const TERMINAL_EVENT_TYPES = new Set(["TASK_SUCCEEDED", "TASK_FAILED"]);

/**
 * Folds each task's scheduler milestones (TASK_CLAIMED, TASK_STARTED,
 * TASK_SUCCEEDED/FAILED) together with its real captured stdout into one
 * ordered feed -- this is the merge the demo-day feedback asked for
 * ("logs and events should be merged"), and it's a real ordering, not
 * flattened-and-hoped: a task's output is only ever captured once it's
 * finished (see kernel's TaskLog -- persisted at completion, never
 * live-streamed), so it always belongs immediately *before* that task's
 * terminal event, after every event that preceded it. A still-running
 * task (no terminal event yet) has no output to place, so its events
 * alone are the whole feed so far.
 *
 * Execution-level events (EXECUTION_CREATED/STARTED/SUCCEEDED/FAILED,
 * `taskId: null`) are deliberately dropped here, not merged into any
 * task's feed -- they added nothing the metadata card above (state chip,
 * Started time, Duration) doesn't already show, which is exactly the
 * "doesn't really reflect anything useful" complaint this merge exists
 * to fix.
 */
function buildMergedFeed(tasksWithLogs: TaskLogs[], events: ExecutionEvent[]): MergedTaskFeed[] {
  const eventsByTask = new Map<string, ExecutionEvent[]>();
  for (const event of events) {
    if (!event.taskId) continue;
    const list = eventsByTask.get(event.taskId);
    if (list) {
      list.push(event);
    } else {
      eventsByTask.set(event.taskId, [event]);
    }
  }

  return tasksWithLogs.map((task) => {
    const taskEvents = eventsByTask.get(task.taskId) ?? [];
    const eventEntries: MergedEntry[] = taskEvents.map((event) => ({
      kind: "event",
      eventType: event.eventType,
      createdAt: event.createdAt,
    }));
    const outputEntries: MergedEntry[] = task.lines.map((line) => ({ kind: "output", line }));
    if (task.hidden > 0) {
      // Only INFO lines reach people outside the step's team.
      outputEntries.push({
        kind: "output",
        line: `(${String(task.hidden)} more line${task.hidden === 1 ? "" : "s"}, debug, warnings and errors: only ${task.visibleTo} sees them)`,
      });
    }

    const lastEvent = taskEvents[taskEvents.length - 1];
    const entries =
      outputEntries.length > 0 && lastEvent && TERMINAL_EVENT_TYPES.has(lastEvent.eventType)
        ? [...eventEntries.slice(0, -1), ...outputEntries, ...eventEntries.slice(-1)]
        : [...eventEntries, ...outputEntries];

    return { taskId: task.taskId, entries, firstTimestamp: taskEvents[0]?.createdAt ?? null };
  });
}

// The log feed sits on the theme's code surface; see theme.ts for the
// contrast of each of these on it.
function eventEntryColor(eventType: string): string {
  if (eventType === "TASK_SUCCEEDED") return "success.light";
  if (eventType === "TASK_FAILED") return "error.light";
  return "code.accent";
}

/**
 * A task's real captured container stdout, merged with its own scheduler
 * milestones (see buildMergedFeed) -- this is what demo attendees asked
 * for: "nothing to show what is happening inside each runtime/step,"
 * plus the milestone timestamps that used to live in a separate, largely
 * redundant Events panel on the Overview tab.
 *
 * Selection is shared with the Overview tab's task cards (`selectedTaskId`
 * lives on the page, not here) -- picking a task there filters this view
 * too, and vice versa via the dropdown below. With nothing selected,
 * every task's feed is shown, grouped under its own heading and ordered
 * by each task's first event -- chronological across tasks, not just
 * whatever order the API happened to return them in.
 */
function ContainerLogsView({
  tasksWithLogs,
  events,
  selectedTaskId,
  onSelectTask,
  isLive,
}: {
  tasksWithLogs: TaskLogs[];
  events: ExecutionEvent[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  isLive: boolean;
}) {
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const mergedFeed = useMemo(() => buildMergedFeed(tasksWithLogs, events), [tasksWithLogs, events]);

  const visibleTasks = useMemo(() => {
    const tasks = selectedTaskId ? mergedFeed.filter((t) => t.taskId === selectedTaskId) : mergedFeed;
    return [...tasks].sort((a, b) => (a.firstTimestamp ?? "").localeCompare(b.firstTimestamp ?? ""));
  }, [mergedFeed, selectedTaskId]);

  const query = search.trim().toLowerCase();
  const filteredTasks = useMemo(
    () =>
      visibleTasks
        .map((task) => ({
          ...task,
          entries: query
            ? task.entries.filter((entry) =>
                (entry.kind === "event" ? entry.eventType : entry.line).toLowerCase().includes(query),
              )
            : task.entries,
        }))
        .filter((task) => task.entries.length > 0),
    [visibleTasks, query],
  );

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [filteredTasks, autoScroll]);

  function handleDownload(): void {
    const text = visibleTasks
      .map((task) =>
        [
          `=== ${task.taskId} ===`,
          ...task.entries.map((entry) =>
            entry.kind === "event"
              ? `${new Date(entry.createdAt).toISOString()} ${entry.eventType}`
              : entry.line,
          ),
        ].join("\n"),
      )
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = selectedTaskId ? `${selectedTaskId}.log` : "execution-output.log";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Box>
      <Box sx={{ display: "flex", gap: 1.5, mb: 2, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          size="small"
          placeholder="Search output"
          slotProps={{ htmlInput: { "aria-label": "Search output" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ minWidth: 220 }}
        />
        <Select
          size="small"
          displayEmpty
          inputProps={{ "aria-label": "Show logs for" }}
          value={selectedTaskId ?? ""}
          onChange={(event) => { onSelectTask(event.target.value || null); }}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="">All tasks (aggregated)</MenuItem>
          {tasksWithLogs.map((task) => (
            <MenuItem key={task.taskId} value={task.taskId} sx={{ fontFamily: "fontFamilyMono" }}>
              {task.taskId}
            </MenuItem>
          ))}
        </Select>
        <FormControlLabel
          control={<Switch size="small" checked={autoScroll} onChange={(event) => { setAutoScroll(event.target.checked); }} />}
          label="Auto-scroll"
        />
        <Button size="small" startIcon={<DownloadIcon />} onClick={handleDownload} sx={{ ml: "auto" }}>
          Download
        </Button>
        {isLive && (
          <Chip icon={<CircleIcon sx={{ fontSize: "8px !important" }} />} label="Live" size="small" color="warning" variant="outlined" />
        )}
      </Box>
      <Paper
        variant="outlined"
        ref={feedRef}
        tabIndex={0}
        role="region"
        aria-label="Log output"
        sx={{
          height: 560,
          overflowY: "auto",
          p: 2,
          bgcolor: "code.background",
          color: "code.text",
          fontFamily: "fontFamilyMono",
          fontSize: 13,
        }}
      >
        {filteredTasks.length === 0 && (
          <Typography variant="body2" sx={{ color: "code.textMuted" }}>
            {mergedFeed.every((t) => t.entries.length === 0)
              ? "Waiting for activity…"
              : "Nothing matches these filters."}
          </Typography>
        )}
        {filteredTasks.map((task, taskIndex) => (
          <Box key={task.taskId} sx={{ mb: taskIndex < filteredTasks.length - 1 ? 2 : 0 }}>
            {!selectedTaskId && (
              <Box
                component="span"
                sx={{ color: "code.accent", fontWeight: 600, display: "block", mb: 0.5 }}
              >
                === {task.taskId} ===
              </Box>
            )}
            {task.entries.map((entry, entryIndex) =>
              entry.kind === "event" ? (
                // eslint-disable-next-line react/no-array-index-key -- neither
                // an event nor an output line has an id stable across this
                // list's own reordering by search/filter; index is fine since
                // this array is rebuilt fresh each render, never mutated.
                <Box key={entryIndex} sx={{ mb: 0.25 }}>
                  <Box component="span" sx={{ color: "code.textMuted" }}>
                    {new Date(entry.createdAt).toLocaleTimeString()}{" "}
                  </Box>
                  <Box component="span" sx={{ color: eventEntryColor(entry.eventType), fontWeight: 600 }}>
                    {entry.eventType}
                  </Box>
                </Box>
              ) : (
                <Box key={entryIndex} sx={{ whiteSpace: "pre-wrap", mb: 0.25, pl: 2 }}>
                  {entry.line}
                </Box>
              ),
            )}
          </Box>
        ))}
      </Paper>
    </Box>
  );
}

export function ExecutionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { execution, events, logs, error, resume } = useExecutionWatch(id);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const theme = useTheme();
  const cardsPerRow = useMediaQuery(theme.breakpoints.up("sm")) ? CARDS_PER_ROW_WIDE : 1;
  const cardWidth = cardWidthCss(cardsPerRow);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Nothing selected when the execution changes: the DAG payload drawer
  // starts closed and Logs on "all tasks (aggregated)".
  useEffect(() => {
    setSelectedTaskId(null);
  }, [id]);

  async function handleCancel(): Promise<void> {
    setActionError(null);
    setBusy("cancel");
    try {
      await cancelExecution(id);
      resume();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Cancel failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(taskId: string): Promise<void> {
    setActionError(null);
    setBusy(taskId);
    try {
      await retryTask(id, taskId);
      // The execution is live again: watch it, even if watching had stopped.
      resume();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Retry failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDecide(taskId: string, approve: boolean, reason: string): Promise<void> {
    setActionError(null);
    setBusy(taskId);
    try {
      await decideApproval(id, taskId, approve, reason);
      resume();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : approve ? "Approving failed." : "Declining failed.");
    } finally {
      setBusy(null);
    }
  }

  // Rerun produces a brand-new execution id (see api.ts's own comment on
  // why), so there's nothing to refresh on this page -- navigate straight
  // to the new execution instead, same as submitting a fresh one would.
  async function handleRerun(): Promise<void> {
    setActionError(null);
    setBusy("rerun");
    try {
      const result = await rerunExecution(id);
      navigate(`/executions/${result.executionId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Rerun failed.");
      setBusy(null);
    }
  }

  const isLive = execution !== null && !TERMINAL_STATES.has(execution.state);

  // The server refuses a rerun in both cases; saying so here beats a
  // button that only fails once clicked.
  // A team problem (or no image source at all) blocks every task; a
  // missing or disallowed image only the tasks that use it.
  function retryBlockedFor(taskId: string): string | null {
    const blocked = execution?.runBlocked;
    if (!blocked) return null;
    const image = execution.payload?.tasks.find((t) => t.id === taskId)?.image;
    if (blocked.error === "IMAGE_NOT_FOUND") {
      return image && blocked.missingImages?.includes(image)
        ? `Image "${image}" no longer exists in the registry.`
        : null;
    }
    if (blocked.error === "IMAGE_NOT_ALLOWED") {
      return image && blocked.disallowedImages?.includes(image)
        ? `Image "${image}" is not from an allowed image source.`
        : null;
    }
    return blocked.message;
  }

  const rerunBlocked =
    execution?.runBlocked?.message ??
    (execution && execution.payload === null
      ? "This execution predates stored submissions, so there's nothing to replay."
      : null);

  // computeStages' own ordering (dependency stage, then within-stage
  // order) flattened into one sequence -- a task's dependencies still
  // read before it even though the grid draws plain rows of 3 rather
  // than one row per dependency stage (see the arrows drawn between
  // cards below, which follow this same order, not the coarse per-stage
  // arrow the old layout used).
  const orderedTasks = useMemo(
    () => (execution ? computeStages(execution.tasks).flat() : []),
    [execution],
  );

  // Clicking an already-selected task deselects it and closes the DAG
  // payload drawer -- the toggle is what makes "nothing selected"
  // (aggregated logs, closed drawer) reachable again without a separate
  // "clear selection" control.
  function handleSelectTask(taskId: string): void {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
  }

  // Rows of (up to) cardsPerRow, in reading order -- rendered in a snake/
  // boustrophedon pattern below: even rows left-to-right, odd rows
  // right-to-left, so task 4 lands directly under task 3, not under
  // task 1 the way a plain wrapping grid would put it.
  const taskRows = useMemo(() => {
    const rows: TaskStatus[][] = [];
    for (let i = 0; i < orderedTasks.length; i += cardsPerRow) {
      rows.push(orderedTasks.slice(i, i + cardsPerRow));
    }
    return rows;
  }, [orderedTasks, cardsPerRow]);

  // Execution-level duration: earliest task start to latest task
  // completion. Real, derived from the same per-task timestamps the task
  // cards show -- there's no separate execution-level start/end field to
  // read instead.
  const executionDuration = (() => {
    if (!execution) return null;
    const starts = execution.tasks.map((t) => t.startedAt).filter((v): v is string => !!v);
    if (starts.length === 0) return null;
    const earliestStart = starts.reduce((a, b) => (a < b ? a : b));
    const completions = execution.tasks.map((t) => t.completedAt).filter((v): v is string => !!v);
    const latestCompletion =
      completions.length === execution.tasks.length
        ? completions.reduce((a, b) => (a > b ? a : b))
        : null;
    return formatDuration(earliestStart, latestCompletion);
  })();

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, mb: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Link component={RouterLink} to="/executions" variant="body2">
            ← Back to executions
          </Link>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5, mt: 0.5 }}>
            <Typography variant="h4" sx={{ fontWeight: 600, fontSize: 28, overflowWrap: "anywhere" }}>
              {execution?.name ?? id}
            </Typography>
            {execution && <StatusBadge status={execution.state} />}
            {execution?.runBlocked && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={RUN_BLOCKED_LABELS[execution.runBlocked.error]}
              />
            )}
          </Box>
        </Box>
        {execution && (
          <Stack direction="row" spacing={1}>
            <Tooltip title={rerunBlocked ?? ""}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy === "rerun" || rerunBlocked !== null}
                  onClick={() => void handleRerun()}
                >
                  {busy === "rerun" ? "Starting…" : "Rerun"}
                </Button>
              </span>
            </Tooltip>
            {!TERMINAL_STATES.has(execution.state) && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                disabled={busy === "cancel"}
                onClick={() => void handleCancel()}
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel"}
              </Button>
            )}
          </Stack>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionError}
        </Alert>
      )}
      {execution?.runBlocked && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {execution.runBlocked.message} Rerun and retry are unavailable; this execution's
          history is kept.
        </Alert>
      )}

      {!execution && !error && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} aria-label="Loading execution" />
        </Box>
      )}

      {execution && (
        <>
          <Card variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <MetadataItem label="Execution ID" value={<Mono>{execution.executionId}</Mono>} />
              <MetadataItem
                label="Team"
                value={
                  <Box sx={{ display: "flex", gap: 0.5 }}>
                    {execution.teams.map((team) => (
                      <Chip key={team} label={team} size="small" />
                    ))}
                  </Box>
                }
              />
              <MetadataItem label="Triggered by" value={execution.submittedBy ?? "—"} />
              {execution.template && (
                <MetadataItem
                  label="From"
                  value={
                    <Tooltip title={`Parameters: ${JSON.stringify(execution.templateParameters ?? {})}`}>
                      <span>
                        <Mono>{execution.template}</Mono>
                        {execution.onBehalfOf && <> for {execution.onBehalfOf}</>}
                      </span>
                    </Tooltip>
                  }
                />
              )}
              <MetadataItem label="Started" value={new Date(execution.createdAt).toLocaleString()} />
              <MetadataItem label="Duration" value={executionDuration ?? "—"} />
            </Box>
          </Card>

          <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", mb: 1.5 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Tasks
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Click a task to see the full DAG payload
            </Typography>
          </Box>
          <Card variant="outlined" sx={{ p: "10px", maxHeight: 700, overflowY: "auto" }}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {taskRows.map((row, rowIndex) => {
                const isReversedRow = rowIndex % 2 === 1;
                // Reversing the *array* for an odd row, rather than
                // flipping the CSS flex-direction, keeps DOM order and
                // rendered left-to-right order identical in every row --
                // task 4 still lands directly under task 3 (the snake
                // layout itself is unchanged), but which icon points
                // which way is now just "is this row reversed," not
                // something that depends on reasoning through how
                // row-reverse itself reorders interleaved children.
                const displayRow = isReversedRow ? [...row].reverse() : row;
                const ArrowIcon = isReversedRow ? ArrowBackIcon : ArrowForwardIcon;
                return (
                  <Box key={rowIndex} sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        // A reversed row hugs the *right* edge, not the
                        // left default -- otherwise a partial reversed row
                        // (as few as one card) sits at the wrong side. A
                        // single card is the case that actually surfaced
                        // this: reversing a 1-element array is a no-op, so
                        // without this it landed under task 1 instead of
                        // under the row above's last card.
                        justifyContent: isReversedRow ? "flex-end" : "flex-start",
                      }}
                    >
                      {displayRow.flatMap((task, indexInDisplay) => {
                        const elements = [
                          <TaskNodeCard
                            key={task.taskId}
                            task={task}
                            width={cardWidth}
                            busy={busy}
                            selected={selectedTaskId === task.taskId}
                            retryBlocked={retryBlockedFor(task.taskId)}
                            onRetry={(taskId) => void handleRetry(taskId)}
                            onDecide={(taskId, approve, reason) => void handleDecide(taskId, approve, reason)}
                            onSelect={handleSelectTask}
                          />,
                        ];
                        if (indexInDisplay < displayRow.length - 1) {
                          // A reversed row reads right-to-left (continuing
                          // the snake down from the row above's rightmost
                          // card), so the connector points back toward the
                          // left there instead of forward toward the right.
                          elements.push(
                            <ArrowIcon
                              key={`${task.taskId}-arrow`}
                              sx={{ color: "text.disabled", flexShrink: 0, width: 24 }}
                            />,
                          );
                        }
                        return elements;
                      })}
                    </Box>
                    {rowIndex < taskRows.length - 1 && (
                      // The turn to the *next* row happens at wherever
                      // *this* row's reading direction just ended: the
                      // right edge after a forward row (task 3 -> task 4
                      // continues down on the right), the left edge after
                      // a reversed one (task 6 -> task 7 continues down on
                      // the left) -- not centered under the row, which
                      // doesn't correspond to any real card.
                      <Box sx={{ display: "flex", justifyContent: isReversedRow ? "flex-start" : "flex-end" }}>
                        <Box sx={{ width: cardWidth, display: "flex", justifyContent: "center" }}>
                          <ArrowDownwardIcon sx={{ color: "text.disabled" }} />
                        </Box>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Card>

          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.5, mt: 3 }}>
            Logs
          </Typography>
          <ContainerLogsView
            tasksWithLogs={logs}
            events={events}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            isLive={isLive}
          />

          <TaskPayloadDrawer
            open={selectedTaskId !== null}
            payload={execution.payload}
            selectedTaskId={selectedTaskId}
            onClose={() => { setSelectedTaskId(null); }}
          />
        </>
      )}
    </Box>
  );
}

const TRIGGER: Record<string, string> = {
  submitted: "asked by",
  retried: "retried by",
  automatic_retry: "retried automatically",
};

/** Each attempt: who asked for it and what acted in it (the kernel's task_attempts). */
function Attempts({ attempts }: { attempts: TaskAttempt[] }) {
  return (
    <Box
      component="details"
      sx={{ mt: 1, "& > summary": { cursor: "pointer", fontSize: 12, color: "text.secondary" } }}
      onClick={(event: MouseEvent) => {
        // Opening the list isn't selecting the step.
        event.stopPropagation();
      }}
    >
      <summary>
        {attempts.length} attempt{attempts.length === 1 ? "" : "s"}: who asked, what ran
      </summary>
      <Box component="ol" sx={{ listStyle: "none", p: 0, m: 0, mt: 0.5, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {attempts.map((a) => (
          <Box component="li" key={a.number} sx={{ fontSize: 12, lineHeight: 1.45 }}>
            <strong>#{a.number}</strong> {TRIGGER[a.trigger] ?? a.trigger}
            {a.requestedBy && ` ${a.requestedBy}`}
            {a.actedAs && (
              <>
                {" · ran as "}
                <Box component="span" sx={{ fontFamily: "fontFamilyMono" }}>
                  {a.actedAs}
                </Box>
              </>
            )}
            {a.failure ? ` · ${a.failure.code}` : a.completedAt ? " · done" : a.startedAt ? " · running" : " · waiting"}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function since(at: string | null): string {
  return at ? new Date(at).toLocaleString() : "";
}

/**
 * A step that needs an approval: who approved it, or that it's waiting, and
 * for a maintainer of its team who didn't submit the run, Approve and
 * Decline (with an optional reason, shown with the failure).
 */
function Approval({
  approval,
  awaiting,
  busy,
  onDecide,
}: {
  approval: TaskApproval;
  awaiting: boolean;
  busy: boolean;
  onDecide: (approve: boolean, reason: string) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  if (!awaiting) {
    return approval.approvedBy ? (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
        Approved by {approval.approvedBy}
        {approval.approvedAt && `, ${since(approval.approvedAt)}`}
      </Typography>
    ) : null;
  }
  return (
    <Box
      sx={{ mt: 1, display: "flex", flexDirection: "column", gap: 1 }}
      onClick={(event: MouseEvent) => {
        // Deciding isn't selecting the step.
        event.stopPropagation();
      }}
    >
      <Typography variant="caption" color="text.secondary">
        Waiting for a maintainer of its team to approve it
        {approval.awaitingSince && `, since ${since(approval.awaitingSince)}`}.
        {!approval.canDecide && " You can't decide on it: only its team's maintainers can, and never whoever ran it."}
      </Typography>
      {approval.canDecide && declining && (
        <TextField
          size="small"
          label="Why (shown with the step)"
          value={reason}
          onChange={(event) => { setReason(event.target.value); }}
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />
      )}
      {approval.canDecide && (
        <Stack direction="row" spacing={1}>
          {declining ? (
            <>
              <Button size="small" color="error" variant="contained" disabled={busy} onClick={() => { onDecide(false, reason); }}>
                {busy ? "Declining…" : "Decline"}
              </Button>
              <Button size="small" disabled={busy} onClick={() => { setDeclining(false); }}>
                Back
              </Button>
            </>
          ) : (
            <>
              <Button size="small" variant="contained" disabled={busy} onClick={() => { onDecide(true, ""); }}>
                {busy ? "Approving…" : "Approve"}
              </Button>
              <Button size="small" color="error" disabled={busy} onClick={() => { setDeclining(true); }}>
                Decline…
              </Button>
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}

const RETRY: Record<string, string> = {
  safe: "Safe to retry: its product finds what an earlier attempt made instead of making it twice.",
  unsafe: "Retry with care: its product doesn't say it's safe to run twice. Check what the failed attempt made first.",
};

/** What a failure means, what to do, whether retrying is safe, and whom to ask. */
function Help({ help }: { help: FailureHelp }) {
  const ask = [help.chat, help.contact].filter(Boolean).join(" · ");
  return (
    <Box sx={{ mt: 1, display: "flex", flexDirection: "column", gap: 0.5, fontSize: 12, lineHeight: 1.45 }}>
      {help.means && (
        <span>
          {help.means}
          {help.whatToDo && ` ${help.whatToDo}`}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {help.fromOwner ? ` (from ${help.team})` : " (from Vertra)"}
          </Box>
        </span>
      )}
      {RETRY[help.retry] && <Box component="span" sx={{ color: help.retry === "safe" ? "success.main" : "warning.dark" }}>{RETRY[help.retry]}</Box>}
      {(ask || help.url) && (
        <Box component="span" sx={{ color: "text.secondary" }}>
          Ask {help.team}: {ask}
          {help.url && (
            <>
              {ask ? " · " : ""}
              <Link href={help.url} target="_blank" rel="noopener noreferrer">
                runbooks
              </Link>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

