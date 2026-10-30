// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { HelpLink, type Help } from "./HelpLink";

/** Every page in this app hand-rolled the same title/subtitle/action-button
 * row slightly differently. One shared header, so that stops drifting.
 * `help`: the guide that explains the page, linked under its subtitle. */
export function PageHeader({
  title,
  subtitle,
  action,
  help,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  help?: Help;
}) {
  return (
    // The actions wrap below the title when there isn't room beside it (a phone).
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", mb: 3, gap: 2 }}>
      <Box sx={{ minWidth: 0, flex: "1 1 320px" }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600, fontSize: { xs: 24, sm: 28 }, overflowWrap: "anywhere" }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5, maxWidth: 820 }}>
            {subtitle}
          </Typography>
        )}
        {help && (
          <Box sx={{ mt: 0.75 }}>
            <HelpLink {...help} />
          </Box>
        )}
      </Box>
      {action && <Box sx={{ flexShrink: 0, maxWidth: "100%" }}>{action}</Box>}
    </Box>
  );
}
