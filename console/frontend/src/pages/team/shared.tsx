// SPDX-License-Identifier: MIT
import { type ReactNode } from "react";
import { Box, ButtonBase, Chip, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";

/** The one-line explanation at the top of each tab. */
export function TabIntro({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 760, mb: 3 }}>
      {children}
    </Typography>
  );
}

export function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap", mb: 1.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, fontSize: 18 }}>
        {title}
      </Typography>
      {aside}
    </Box>
  );
}

/** A large radio-style option: a title, a description, and a selected
 * state. A real button, so it works with the keyboard. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  badge,
  disabled = false,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <ButtonBase
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      sx={{
        width: "100%",
        textAlign: "left",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        gap: 1.5,
        p: 2,
        borderRadius: 2,
        border: 1,
        borderColor: selected ? "primary.main" : "divider",
        boxShadow: selected ? (theme) => `inset 0 0 0 1px ${theme.palette.primary.main}` : "none",
        bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.05) : "background.paper",
        opacity: disabled ? 0.55 : 1,
        "&:hover": { borderColor: disabled ? "divider" : "primary.main" },
      }}
    >
      <Box
        sx={{
          width: 18,
          height: 18,
          mt: 0.25,
          borderRadius: "50%",
          flexShrink: 0,
          boxSizing: "border-box",
          border: selected ? "6px solid" : "2px solid",
          borderColor: selected ? "primary.main" : "text.disabled",
        }}
      />
      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
          {badge}
        </Box>
        {description && (
          <Typography variant="body2" color="text.secondary" component="div">
            {description}
          </Typography>
        )}
        {children}
      </Stack>
    </ButtonBase>
  );
}

/** Numbered steps across the top of a flow; done steps get a check. */
export function Steps({ labels, current }: { labels: string[]; current: number }) {
  return (
    <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", mb: 2.5 }}>
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <Box key={label} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                bgcolor: active ? "primary.main" : done ? "success.light" : "action.selected",
                color: active || done ? "common.white" : "text.secondary",
              }}
            >
              {done ? <CheckIcon sx={{ fontSize: 16 }} /> : step}
            </Box>
            <Typography
              variant="body2"
              sx={{ fontWeight: active ? 600 : 400, color: active ? "text.primary" : "text.secondary" }}
            >
              {label}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** A label/value grid for a detail panel. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 1.5, rowGap: 0.5, fontSize: 14 }}>
      {rows.map(([label, value]) => (
        <Box key={label} sx={{ display: "contents" }}>
          <Typography variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}


export function NotYetTested() {
  return <Chip label="Not yet tested" size="small" variant="outlined" />;
}

/** "3 min ago", "2 h ago", or a date for anything older than a day. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** ESO's Go durations ("1h0m0s") as people write them ("1h"). */
export function shortDuration(value: string): string {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
  if (!match) return value;
  const parts = [
    [match[1], "h"],
    [match[2], "m"],
    [match[3], "s"],
  ].filter(([amount]) => amount !== undefined && Number(amount) !== 0);
  return parts.length ? parts.map(([amount, unit]) => `${String(Number(amount))}${unit ?? ""}`).join(" ") : value;
}
