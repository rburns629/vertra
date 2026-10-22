// SPDX-License-Identifier: MIT
import { useTheme } from "@mui/material/styles";
import { statusColor, statusFill, statusLabel } from "../statusColor";
import { Pill } from "./Pill";

/** One place every status pill in the app renders from: a tint, its
 * state's dot and label (statusColor.ts, which the charts share too). */
export function StatusBadge({ status, size = "small" }: { status: string; size?: "small" | "medium" }) {
  const theme = useTheme();
  return (
    <Pill tone={statusColor(status)} dot={statusFill(theme, status)} size={size}>
      {statusLabel(status)}
    </Pill>
  );
}
