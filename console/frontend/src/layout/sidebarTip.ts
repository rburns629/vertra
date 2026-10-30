// SPDX-License-Identifier: MIT
import type { TooltipProps } from "@mui/material/Tooltip";

/**
 * The collapsed sidebar's names on hover: light on the dark column, beside
 * the icon (board 13d), where the app's dark tooltips would sink into it.
 */
export const SIDEBAR_TIP: Pick<TooltipProps, "placement" | "slotProps"> = {
  placement: "right",
  slotProps: {
    tooltip: {
      sx: {
        bgcolor: "background.paper",
        color: "text.primary",
        fontSize: 13,
        fontWeight: 500,
        px: 1.25,
        py: 0.75,
        borderRadius: 1.5,
        boxShadow: "0 4px 12px rgba(0,0,0,.3)",
      },
    },
    arrow: { sx: { color: "background.paper" } },
  },
};
