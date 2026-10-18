// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";

/** Inline identifiers in running text: a name, a path, a field, an id.
 * Slightly smaller than the surrounding text, since monospace runs wide. */
export function Mono({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Box
      component="span"
      sx={[{ fontFamily: "fontFamilyMono", fontSize: "0.92em" }, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      {children}
    </Box>
  );
}
