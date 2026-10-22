// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TaskStatus } from "../../api";
import { FailureHelp } from "./FailureHelp";

/**
 * Why a failed run stopped, at the top of its page: the step, its error
 * code and message, and what that means and what to do about it.
 */
export function FailureCard({
  task,
  position,
  busy,
  retryBlocked,
  onRetry,
  onShow,
}: {
  task: TaskStatus;
  /** "step 3 of 4". */
  position: string;
  busy: boolean;
  retryBlocked: string | null;
  onRetry: () => void;
  onShow: () => void;
}) {
  if (!task.failure) return null;
  return (
    <Card sx={{ p: 3, borderColor: "error.light", borderWidth: 1, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography variant="h6" component="h2">
          Failed at {position}, {task.taskId}: {task.failure.message}
        </Typography>
        <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 13, color: "error.dark", fontWeight: 500 }}>{task.failure.code}</Typography>
      </Box>
      {task.help && <FailureHelp help={task.help} />}
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Tooltip title={retryBlocked ?? (task.failure.retryable ? "" : "This failure is marked not retryable.")}>
          <span>
            <Button variant="contained" disabled={busy || retryBlocked !== null} onClick={onRetry}>
              {busy ? "Retrying…" : `Retry ${task.taskId}`}
            </Button>
          </span>
        </Tooltip>
        <Button onClick={onShow}>Show its attempts and logs</Button>
      </Box>
    </Card>
  );
}
