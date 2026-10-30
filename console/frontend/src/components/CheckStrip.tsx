// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import WarningIcon from "@mui/icons-material/WarningAmberOutlined";

export interface Check {
  /** success: settled; info: something done for you; warning or error: to look at. */
  tone: "success" | "info" | "warning" | "error";
  text: ReactNode;
}

const ICON = { success: <CheckIcon />, info: <AddIcon />, warning: <WarningIcon />, error: <WarningIcon /> };

/**
 * A one-line account of a plan, its checks in a row after a label ("The
 * plan", "Checks"): each with an icon and words, never color alone.
 * `compact` stacks them, for a side panel.
 */
export function CheckStrip({ label, checks, compact = false }: { label?: ReactNode; checks: Check[]; compact?: boolean }) {
  return (
    <Box
      role="status"
      sx={{
        display: "flex",
        flexDirection: compact ? "column" : "row",
        flexWrap: "wrap",
        gap: compact ? 0.75 : "8px 20px",
        alignItems: compact ? "flex-start" : "center",
        fontSize: 13,
        ...(!compact && { bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: "10px", px: 2, py: 1.5 }),
      }}
    >
      {label && <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{label}</Typography>}
      {checks.map((c, i) => (
        <Box
          key={i}
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "flex-start",
            gap: 0.75,
            lineHeight: 1.45,
            color: c.tone === "info" ? "info.main" : `${c.tone}.${c.tone === "success" ? "dark" : "main"}`,
            "& svg": { fontSize: 16, mt: "1px", flexShrink: 0 },
          }}
        >
          {ICON[c.tone]}
          <span>{c.text}</span>
        </Box>
      ))}
    </Box>
  );
}
