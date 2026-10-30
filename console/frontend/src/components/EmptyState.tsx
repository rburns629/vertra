// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { HelpLink, type Help } from "./HelpLink";

/** A concise explanation plus one clear action, never a blank table body
 * or a cartoon illustration -- the same "nothing here yet" moment every
 * list page eventually hits. `title` says what's missing, `message` what
 * to do about it, and `help` where that's explained. */
export function EmptyState({ title, message, action, help }: { title?: ReactNode; message: ReactNode; action?: ReactNode; help?: Help }) {
  return (
    <Box sx={{ py: 5, px: 2, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
      {title && (
        <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600, textAlign: "center" }}>
          {title}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", maxWidth: 520, mt: title ? -1 : 0 }}>
        {message}
      </Typography>
      {action}
      {help && <HelpLink {...help} />}
    </Box>
  );
}
