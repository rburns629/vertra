// SPDX-License-Identifier: MIT
import { useId, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";

/**
 * A card that is one section of a page: its heading (an icon before it,
 * when given), a link or note on the heading's right, and what it holds.
 * `tone` edges it: info for what's about the install or a helper, warning
 * for what waits on you.
 */
export function Panel({
  title,
  icon,
  action,
  tone,
  children,
  id,
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  tone?: "info" | "warning";
  children: ReactNode;
  id?: string;
}) {
  const headingId = useId();
  return (
    <Card
      component="section"
      id={id}
      aria-labelledby={headingId}
      sx={{
        p: { xs: 2, sm: 2.5 },
        display: "flex",
        flexDirection: "column",
        gap: 1.75,
        minWidth: 0,
        ...(tone === "info" && { borderColor: "tint.infoBorder" }),
        ...(tone === "warning" && { borderColor: "tint.warningBorder", bgcolor: "tint.warningSurface" }),
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1.25, flexWrap: "wrap" }}>
        <Typography id={headingId} variant="h6" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1, "& svg": { fontSize: 18 } }}>
          {icon}
          {title}
        </Typography>
        {action && <Box sx={{ fontSize: 13 }}>{action}</Box>}
      </Box>
      {children}
    </Card>
  );
}
