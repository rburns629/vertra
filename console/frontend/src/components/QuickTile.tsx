// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";

/**
 * A count at a glance that is also a filter: its label (with a state's dot),
 * the number, a line about it. Pressed while its filter is on.
 */
export function QuickTile({
  label,
  value,
  note,
  dot,
  pressed,
  onClick,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  dot: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      aria-pressed={pressed}
      onClick={onClick}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 0.25,
        px: 2,
        py: 1.5,
        minWidth: 0,
        textAlign: "left",
        border: 1,
        borderColor: pressed ? "primary.main" : "divider",
        borderRadius: "10px",
        bgcolor: pressed ? "info.light" : "background.paper",
        "&:hover": { bgcolor: pressed ? "info.light" : "action.hover" },
      }}
    >
      <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 13, color: "text.secondary" }}>
        <Box component="span" aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: dot, flexShrink: 0 }} />
        {label}
      </Box>
      <Typography component="span" sx={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Typography>
      {note && (
        <Typography component="span" sx={{ fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>
          {note}
        </Typography>
      )}
    </ButtonBase>
  );
}

/** Tiles in a row of four, two on a phone. */
export function QuickTiles({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box component="section" aria-label={label} sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 1.5 }}>
      {children}
    </Box>
  );
}
