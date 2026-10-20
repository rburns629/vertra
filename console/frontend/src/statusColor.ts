// SPDX-License-Identifier: MIT
import type { ChipProps } from "@mui/material/Chip";
import type { Theme } from "@mui/material/styles";

/** Maps kernel's real ExecutionState/TaskState strings (see kernel/
 * internal/domain/states.go) to a Chip color -- one place, so a status reads the
 * same way everywhere it appears (list, detail, home's recent-activity,
 * home's charts). */
export function statusColor(state: string): ChipProps["color"] {
  switch (state) {
    case "SUCCEEDED":
      return "success";
    case "FAILED":
      return "error";
    case "CANCELLED":
      return "default";
    case "RUNNING":
    case "CLAIMED":
      return "warning";
    default: // PENDING, READY, BLOCKED
      return "info";
  }
}

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  RUNNING: "Running",
  CLAIMED: "Claimed",
  PENDING: "Pending",
  READY: "Ready",
  BLOCKED: "Blocked",
};

/** The human label for a state, instead of the raw kernel enum string. */
export function statusLabel(state: string): string {
  return STATUS_LABEL[state] ?? state;
}

/** The state's chip color as a CSS color, for things that aren't chips
 * (chart bars and slices), so a chart's Running is the chips' Running. */
export function statusFill(theme: Theme, state: string): string {
  const color = statusColor(state);
  if (!color || color === "default") return theme.palette.grey[600];
  return theme.palette[color].main;
}
