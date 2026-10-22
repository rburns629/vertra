// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import { statusColor, statusFill, statusLabel } from "../statusColor";

/** One place every status pill in the app renders from: a tint, its
 * state's dot and label (statusColor.ts, which the charts share too). */
export function StatusBadge({ status, size = "small" }: { status: string; size?: "small" | "medium" }) {
  const theme = useTheme();
  const color = statusColor(status);
  const tone = !color || color === "default" ? null : theme.palette[color];
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        whiteSpace: "nowrap",
        fontSize: size === "small" ? 12 : 13,
        fontWeight: 500,
        lineHeight: 1.4,
        px: 1.25,
        py: size === "small" ? 0.375 : 0.625,
        borderRadius: 999,
        color: tone ? tone.dark : "text.secondary",
        bgcolor: tone ? tone.light : "#ECEEF2",
      }}
    >
      <Box component="span" aria-hidden="true" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: statusFill(theme, status), flexShrink: 0 }} />
      {statusLabel(status)}
    </Box>
  );
}
