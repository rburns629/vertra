// SPDX-License-Identifier: MIT
import { useTheme } from "@mui/material/styles";
import type { ApiProduct } from "../../api";
import { Pill, type PillTone } from "../../components/Pill";

const STATE: Record<ApiProduct["state"], { label: string; tone: PillTone }> = {
  LIVE: { label: "Live", tone: "success" },
  HELD: { label: "Held", tone: "warning" },
  PAUSED: { label: "Paused", tone: "warning" },
  UNSPECIFIED: { label: "Unknown", tone: "neutral" },
};

/** An API's state: Live, Held (its backend's host isn't allowed yet), or Paused by its team. */
export function ApiStatePill({ state }: { state: ApiProduct["state"] }) {
  const theme = useTheme();
  const { label, tone } = STATE[state];
  return (
    <Pill tone={tone} dot={tone === "neutral" ? theme.palette.grey[500] : theme.palette[tone].main}>
      {label}
    </Pill>
  );
}
