// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";

/** Extracted from HomePage's own stat cards -- the one place a raw number
 * (teams, executions, ...) gets presented as a headline metric. `note`
 * says what's behind the number, under it. */
export function MetricCard({ label, value, icon, note }: { label: string; value: ReactNode; icon?: ReactNode; note?: ReactNode }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.secondary", mb: 1 }}>
          {icon}
          <Typography variant="body2">{label}</Typography>
        </Box>
        <Typography variant="h4" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </Typography>
        {note && (
          <Typography variant="caption" component="div" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {note}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
