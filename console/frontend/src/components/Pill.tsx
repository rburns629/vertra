// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";

export type PillTone = "success" | "warning" | "error" | "info" | "neutral";

/** A small tinted label: a state, a status. A dot of `dot`'s color leads it, when given. */
export function Pill({
  tone,
  dot,
  size = "small",
  title,
  children,
}: {
  tone: PillTone;
  dot?: string;
  size?: "small" | "medium";
  title?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  const palette = tone === "neutral" ? null : theme.palette[tone];
  return (
    <Box
      component="span"
      title={title}
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
        color: palette ? palette.dark : "text.secondary",
        bgcolor: palette ? palette.light : "#ECEEF2",
      }}
    >
      {dot && <Box component="span" aria-hidden="true" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: dot, flexShrink: 0 }} />}
      {children}
    </Box>
  );
}
