// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import type { SubmittedTaskPayload, TaskStatus } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { imageName } from "../../imageRef";
import { duration } from "../../time";

/** One bar on the timeline: an attempt, or the wait for an approval. */
interface Bar {
  key: string;
  from: number;
  to: number;
  kind: "succeeded" | "failed" | "running" | "approval";
  label: string;
}

function barsOf(task: TaskStatus, now: number): Bar[] {
  const bars: Bar[] = [];
  if (task.approval?.awaitingSince) {
    const from = Date.parse(task.approval.awaitingSince);
    const to = task.approval.approvedAt ? Date.parse(task.approval.approvedAt) : now;
    bars.push({ key: "approval", from, to, kind: "approval", label: `Waiting for an approval, ${duration(to - from)}` });
  }
  for (const a of task.attempts) {
    if (!a.startedAt) continue;
    const from = Date.parse(a.startedAt);
    const to = a.completedAt ? Date.parse(a.completedAt) : now;
    const kind = a.failure ? "failed" : a.completedAt ? "succeeded" : "running";
    const what = a.failure ? `failed: ${a.failure.code}` : a.completedAt ? "succeeded" : "running";
    bars.push({ key: `attempt-${String(a.number)}`, from, to, kind, label: `Attempt ${String(a.number)} ${what} after ${duration(to - from)}` });
  }
  return bars;
}

/** "0", "3 min", "6 min", ...: four ticks across the run. */
function ticks(span: number): { at: number; label: string }[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const at = (span * i) / 4;
    const minutes = at / 60_000;
    const label =
      i === 0 ? "0" : minutes >= 120 ? `${String(Math.round(minutes / 60))} h` : minutes >= 1 ? `${String(Math.round(minutes))} min` : `${String(Math.round(at / 1000))}s`;
    return { at, label };
  });
}

/**
 * The run's steps against time, in dependency order: each attempt a bar
 * (green done, red failed, blue running), an approval's wait amber. Each
 * row is a button that selects its step.
 */
export function RunTimeline({
  tasks,
  definitions,
  startedAt,
  now,
  selected,
  onSelect,
}: {
  tasks: TaskStatus[];
  definitions: Map<string, SubmittedTaskPayload>;
  startedAt: string;
  now: number;
  selected: string;
  onSelect: (taskId: string) => void;
}) {
  const theme = useTheme();
  const rows = tasks.map((task) => ({ task, bars: barsOf(task, now) }));
  const start = Date.parse(startedAt);
  const end = Math.max(start + 1000, ...rows.flatMap((r) => r.bars.map((b) => b.to)));
  const span = end - start;
  const pct = (t: number) => `${String(((t - start) / span) * 100)}%`;
  const color: Record<Bar["kind"], string> = {
    succeeded: theme.palette.success.main,
    failed: theme.palette.error.main,
    running: theme.palette.primary.main,
    approval: theme.palette.warning.main,
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: { xs: "none", sm: "grid" }, gridTemplateColumns: "minmax(180px, 260px) 1fr", gap: 2, px: 1.5, pb: 1 }}>
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
        return (
          <ButtonBase
            key={task.taskId}
            onClick={() => { onSelect(task.taskId); }}
            aria-pressed={isSelected}
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "minmax(180px, 260px) 1fr" },
              gap: { xs: 1, sm: 2 },
              alignItems: "center",
              textAlign: "left",
              px: 1.5,
              py: 1.25,
              borderRadius: 2,
              bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.07) : undefined,
              outline: isSelected ? `1px solid ${alpha(theme.palette.primary.main, 0.35)}` : undefined,
              "&:hover": { bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.09) : "action.hover" },
            }}
          >
            <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.taskId}</Typography>
                <Box sx={{ display: { sm: "none" } }}>
                  <StatusBadge status={task.state} />
                </Box>
              </Box>
              {definition && (
                <Typography sx={{ fontSize: 12, color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {imageName(definition.image)} · {definition.action} · {definition.team}
                </Typography>
              )}
            </Box>
            <Box sx={{ position: "relative", height: 22, borderRadius: 1, bgcolor: "action.hover" }}>
              {bars.length === 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ position: "absolute", left: 8, top: 2 }}>
                  {task.dependsOn.length > 0 ? `After ${task.dependsOn.join(", ")}` : "Not started"}
                </Typography>
              )}
              {bars.map((bar) => (
                <Box
                  key={bar.key}
                  title={bar.label}
                  aria-label={bar.label}
                  role="img"
                  sx={{
                    position: "absolute",
                    top: 3,
                    bottom: 3,
                    left: pct(bar.from),
                    width: `max(4px, calc(${pct(bar.to)} - ${pct(bar.from)}))`,
                    borderRadius: "4px",
                    bgcolor: color[bar.kind],
                    opacity: bar.kind === "failed" && task.state !== "FAILED" ? 0.55 : 1,
                  }}
                />
              ))}
            </Box>
          </ButtonBase>
        );
      })}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, px: 1.5, pt: 1.5 }}>
        {(
          [
            ["succeeded", "Succeeded"],
            ["failed", "Failed"],
            ["running", "Running"],
            ["approval", "Waiting for an approval"],
          ] as const
        ).map(([kind, label]) => (
          <Box key={kind} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Box aria-hidden="true" sx={{ width: 14, height: 8, borderRadius: "2px", bgcolor: color[kind] }} />
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
