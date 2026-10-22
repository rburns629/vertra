// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

/** Every page in this app hand-rolled the same title/subtitle/action-button
 * row slightly differently. One shared header, so that stops drifting. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    // The actions wrap below the title when there isn't room beside it (a phone).
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", mb: 3, gap: 2 }}>
      <Box sx={{ minWidth: 0, flex: "1 1 320px" }}>
        <Typography variant="h4" sx={{ fontWeight: 600, fontSize: 28, overflowWrap: "anywhere" }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {action && <Box sx={{ flexShrink: 0, maxWidth: "100%" }}>{action}</Box>}
    </Box>
  );
}
