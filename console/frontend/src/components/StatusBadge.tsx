// SPDX-License-Identifier: MIT
import Chip from "@mui/material/Chip";
import { statusColor, statusLabel } from "../statusColor";

/** One place every status pill in the app renders from; its color and
 * label both come from statusColor.ts, which the home charts share. */
export function StatusBadge({ status, size = "small" }: { status: string; size?: "small" | "medium" }) {
  return (
    <Chip
      label={statusLabel(status)}
      color={statusColor(status)}
      size={size}
      sx={{ fontWeight: 600 }}
    />
  );
}
