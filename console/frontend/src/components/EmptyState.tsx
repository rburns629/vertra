// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

/** A concise explanation plus one clear action, never a blank table body
 * or a cartoon illustration -- the same "nothing here yet" moment every
 * list page eventually hits. */
export function EmptyState({ message, action }: { message: ReactNode; action?: ReactNode }) {
  return (
    <Box sx={{ py: 5, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
        {message}
      </Typography>
      {action}
    </Box>
  );
}
