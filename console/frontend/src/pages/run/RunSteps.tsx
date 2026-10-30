// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import type { TaskStatus } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { duration } from "../../time";

const NOT_STARTED = new Set(["PENDING", "READY", "BLOCKED", "CANCELLED"]);

/** A finished step's pill: how it ended and how long it took, or that it never started. */
function StepState({ task }: { task: TaskStatus }) {
  const last = task.attempts.at(-1);
  if (task.attempts.length === 0 && NOT_STARTED.has(task.state)) return <StatusBadge status="CANCELLED" label="Never started" />;
  const took = task.state === "SUCCEEDED" && last?.startedAt && last.completedAt ? duration(Date.parse(last.completedAt) - Date.parse(last.startedAt)) : undefined;
  return <StatusBadge status={task.state} detail={took} />;
}

/** A finished run's steps in order, numbered, each with how it ended; picking one shows it. */
export function RunSteps({ tasks, selected, onSelect }: { tasks: TaskStatus[]; selected: string; onSelect: (taskId: string) => void }) {
  return (
    <Card component="section" aria-labelledby="steps-heading" sx={{ p: { xs: 2, sm: 2.75 }, display: "flex", flexDirection: "column" }}>
      <Typography id="steps-heading" variant="h6" component="h2" sx={{ mb: 1 }}>
        Steps
      </Typography>
      {tasks.map((task, i) => (
        <ButtonBase
          key={task.taskId}
          aria-current={task.taskId === selected ? "step" : undefined}
          onClick={() => { onSelect(task.taskId); }}
          sx={{ display: "flex", justifyContent: "space-between", gap: 1.5, py: 1.125, minHeight: 44, borderTop: 1, borderColor: "divider", textAlign: "left", fontSize: 13 }}
        >
          <Typography component="span" sx={{ fontSize: 13, fontWeight: task.taskId === selected ? 600 : 400, overflowWrap: "anywhere", minWidth: 0 }}>
            {i + 1}. {task.taskId}
          </Typography>
          <Box sx={{ flexShrink: 0 }}>
            <StepState task={task} />
          </Box>
        </ButtonBase>
      ))}
    </Card>
  );
}
