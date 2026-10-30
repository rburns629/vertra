// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import type { SubmittedTaskPayload, TaskStatus } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { imageName } from "../../imageRef";
import { duration } from "../../time";

type Kind = "succeeded" | "retried" | "failed" | "running" | "waiting";

/** One bar on the timeline: an attempt, the wait for an approval, or the wait for steps before it. */
interface Bar {
  key: string;
  from: number;
  to: number;
  kind: Kind;
  /** Inside the bar, where it fits. */
  text: string;
  /** In full, for a screen reader and on hover. */
  label: string;
}

function barsOf(task: TaskStatus, now: number): Bar[] {
  const bars: Bar[] = [];
  if (task.approval?.awaitingSince) {
    const from = Date.parse(task.approval.awaitingSince);
    const to = task.approval.approvedAt ? Date.parse(task.approval.approvedAt) : now;
    bars.push({ key: "approval", from, to, kind: "waiting", text: "approval", label: `Waiting for an approval, ${duration(to - from)}` });
  }
  const many = task.attempts.length > 1;
  for (const a of task.attempts) {
    if (!a.startedAt) continue;
    const from = Date.parse(a.startedAt);
    const to = a.completedAt ? Date.parse(a.completedAt) : now;
    const last = a.number === task.attempts.at(-1)?.number;
    const kind: Kind = a.failure ? (last ? "failed" : "retried") : a.completedAt ? "succeeded" : "running";
    const what = a.failure ? `failed: ${a.failure.code}` : a.completedAt ? "succeeded" : "running";
    const took = duration(to - from);
    const text = kind === "failed" ? `${a.failure?.code ?? ""} · ${took}` : many ? (last ? `#${String(a.number)} · ${took}` : `#${String(a.number)}`) : took;
    bars.push({ key: `attempt-${String(a.number)}`, from, to, kind, text, label: `Attempt ${String(a.number)} ${what} after ${took}` });
  }
  return bars;
}

/** "0", "1m 30s", "3m", ...: five ticks across the run. */
function ticks(span: number): { at: number; label: string }[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const at = (span * i) / 4;
    return { at, label: i === 0 ? "0" : duration(at).replace(/ 00s$/, "") };
  });
}

/** What the row says under the step's name: what it ran, and how it went in a word. */
function summary(task: TaskStatus, bars: Bar[], finished: boolean): string {
  if (task.attempts.length > 1) return `${String(task.attempts.length)} attempts`;
  const attempt = bars.find((b) => b.key.startsWith("attempt-"));
  if (attempt) return task.state === "FAILED" ? "failed" : duration(attempt.to - attempt.from);
  if (task.state === "FAILED") return "failed before it started";
  if (task.state === "AWAITING_APPROVAL") return "waiting for an approval";
  return finished ? "never started" : "waiting";
}

/**
 * The run's steps against time, in dependency order: each attempt a bar
 * (green done, amber failed and retried, red failed, blue running), each
 * wait dashed. Each row is a button that selects its step.
 */
export function RunTimeline({
  tasks,
  definitions,
  startedAt,
  now,
  finished,
  selected,
  onSelect,
}: {
  tasks: TaskStatus[];
  definitions: Map<string, SubmittedTaskPayload>;
  startedAt: string;
  now: number;
  /** The run is over: a step with no attempt never started. */
  finished: boolean;
  selected: string;
  onSelect: (taskId: string) => void;
}) {
  const theme = useTheme();
  const rows = tasks.map((task) => ({ task, bars: barsOf(task, now) }));
  const start = Date.parse(startedAt);
  const end = Math.max(start + 1000, ...rows.flatMap((r) => r.bars.map((b) => b.to)));
  const span = end - start;
  const ended = new Map(rows.map((r) => [r.task.taskId, Math.max(start, ...r.bars.map((b) => b.to))]));
  const pct = (t: number) => `${String(((t - start) / span) * 100)}%`;
  const fill: Record<Kind, string> = {
    succeeded: theme.palette.success.main,
    retried: theme.palette.warning.main,
    failed: theme.palette.error.main,
    running: theme.palette.primary.main,
    waiting: "transparent",
  };
  const present = new Set(rows.flatMap((r) => r.bars.map((b) => b.kind)));
  const neverStarted = rows.some((r) => r.bars.length === 0 && r.task.state !== "FAILED");
  const legend: [Kind, string][] = [
    ["succeeded", "Succeeded"],
    ...(present.has("retried") ? ([["retried", "Failed, retried"]] as [Kind, string][]) : []),
    ["failed", "Failed"],
    ["running", "Running"],
    ...(present.has("waiting") || neverStarted
      ? ([["waiting", finished && !present.has("waiting") ? "Never started" : "Waiting on another step or an approval"]] as [Kind, string][])
      : []),
  ];

  const barSx = (kind: Kind) => ({
    position: "absolute",
    top: 3,
    bottom: 3,
    boxSizing: "border-box",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    px: 1,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: 11,
    fontWeight: 500,
    bgcolor: fill[kind],
    color: kind === "waiting" ? "text.primary" : "common.white",
    border: kind === "waiting" ? `1px dashed ${theme.palette.grey[600]}` : 0,
  });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: { xs: "none", sm: "grid" }, gridTemplateColumns: "minmax(180px, 240px) 1fr", gap: 2, pb: 0.75, borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="caption" color="text.secondary">
          Step
        </Typography>
        <Box sx={{ position: "relative", height: 16 }}>
          {ticks(span).map((t) => (
            <Typography
              key={t.at}
              variant="caption"
              color="text.secondary"
              sx={{ position: "absolute", left: `${String((t.at / span) * 100)}%`, transform: t.at === 0 ? "none" : t.at === span ? "translateX(-100%)" : "translateX(-50%)", whiteSpace: "nowrap" }}
            >
              {t.label}
            </Typography>
          ))}
        </Box>
      </Box>
      {rows.map(({ task, bars }) => {
        const definition = definitions.get(task.taskId);
        const isSelected = task.taskId === selected;
        const unstarted = task.state === "FAILED" ? "failed before it started" : task.dependsOn.length > 0 ? `after ${task.dependsOn.join(", ")}` : finished ? "never started" : "not started";
        // From where the steps before it ended, but wide enough to read.
        const waitFrom = Math.min(Math.max(start, ...task.dependsOn.map((d) => ended.get(d) ?? start)), end - span * 0.3);
        return (
          <ButtonBase
            key={task.taskId}
            onClick={() => { onSelect(task.taskId); }}
            aria-pressed={isSelected}
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "minmax(180px, 240px) minmax(0, 1fr)" },
              gap: { xs: 1, sm: 2 },
              alignItems: "center",
              textAlign: "left",
              p: 1,
              mx: -1,
              borderRadius: 2,
              bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.06) : undefined,
              outline: isSelected ? `1px solid ${alpha(theme.palette.primary.main, 0.3)}` : undefined,
              "&:hover": { bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.08) : "action.hover" },
            }}
          >
            <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.taskId}</Typography>
                <Box sx={{ display: { sm: "none" } }}>
                  <StatusBadge status={task.state} />
                </Box>
              </Box>
              <Typography sx={{ fontSize: 12, color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {definition ? `${imageName(definition.image)} · ${definition.action} · ${definition.team} · ` : ""}
                {summary(task, bars, finished)}
              </Typography>
            </Box>
            <Box sx={{ position: "relative", height: 28, borderRadius: 1.5, bgcolor: "action.hover" }}>
              {bars.length === 0 && (
                <Box
                  role="img"
                  aria-label={unstarted}
                  title={unstarted}
                  sx={{ ...barSx(task.state === "FAILED" ? "failed" : "waiting"), left: pct(waitFrom), width: `max(4px, calc(100% - ${pct(waitFrom)}))` }}
                >
                  {unstarted}
                </Box>
              )}
              {bars.map((bar) => (
                <Box
                  key={bar.key}
                  title={bar.label}
                  aria-label={bar.label}
                  role="img"
                  sx={{ ...barSx(bar.kind), left: pct(bar.from), width: `max(4px, calc(${pct(bar.to)} - ${pct(bar.from)}))` }}
                >
                  <Box component="span" aria-hidden="true">
                    {bar.text}
                  </Box>
                </Box>
              ))}
            </Box>
          </ButtonBase>
        );
      })}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", pt: 1.25 }}>
        {legend.map(([kind, label]) => (
          <Box key={kind} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Box
              aria-hidden="true"
              sx={{ width: 14, height: 10, borderRadius: "2px", boxSizing: "border-box", bgcolor: fill[kind], border: kind === "waiting" ? `1px dashed ${theme.palette.grey[600]}` : 0 }}
            />
            <Typography variant="caption" sx={{ color: "text.primary" }}>
              {label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
