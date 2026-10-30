// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";

/** A part's state, as the Admin page's dots show it: fine, needs a look, needs action, or off. */
export type Tone = "ok" | "warn" | "err" | "off";

const DOT: Record<Tone, string> = { ok: "success.main", warn: "warning.main", err: "error.main", off: "text.disabled" };
/** What a dot means, for a screen reader: the color never says it alone. */
export const TONE_WORD: Record<Tone, string> = { ok: "fine", warn: "needs a look", err: "needs action", off: "off" };
/** A Pill's tone for a dot's. */
export const PILL_TONE = { ok: "success", warn: "warning", err: "error", off: "neutral" } as const;

/** Text only a screen reader reads. */
export function SrOnly({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
      {children}
    </Box>
  );
}

/** A state's colored dot: decoration beside words that say the same. */
export function Dot({ tone, sx }: { tone: Tone; sx?: SxProps<Theme> }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={[{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px", display: "inline-block", bgcolor: DOT[tone] }, ...(Array.isArray(sx) ? sx : [sx])]}
    />
  );
}

/**
 * One of the Admin page's cards: a heading, what it says about its state
 * at the right, and its content. `accent` marks the left edge (something
 * needs you); `danger` outlines it (closing the gateway).
 */
export function AdminCard({
  title,
  status,
  accent,
  danger,
  label,
  children,
  sx,
}: {
  title?: ReactNode;
  status?: ReactNode;
  accent?: "warning" | "error";
  danger?: boolean;
  /** The region's name, when it differs from its heading. */
  label?: string;
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Card
      component="section"
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      sx={[
        { p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 },
        accent ? { borderLeft: 4, borderLeftColor: `${accent}.main` } : {},
        danger ? { borderColor: "error.light", boxShadow: (t) => `inset 0 0 0 1px ${t.palette.error.light}` } : {},
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {(title || status) && (
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
          {title && (
            <Typography variant="h6" component="h2">
              {title}
            </Typography>
          )}
          {status}
        </Box>
      )}
      {children}
    </Card>
  );
}

/** A card's quiet note at the right of its heading ("Kept 90 days"). */
export function Aside({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}

/** Name and value pairs, the name muted: a card's facts. */
export function KeyValues({ rows, nameWidth = 168 }: { rows: [ReactNode, ReactNode][]; nameWidth?: number }) {
  return (
    <Box
      component="dl"
      sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: `minmax(${String(nameWidth)}px, auto) minmax(0, 1fr)` }, columnGap: 2.25, rowGap: { xs: 0.25, sm: 1.25 }, fontSize: 14 }}
    >
      {rows.map(([name, value], i) => (
        <Box key={i} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ color: "text.secondary", mt: { xs: i === 0 ? 0 : 1, sm: 0 } }}>
            {name}
          </Box>
          <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere" }}>
            {value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** A plain table in a card, the boards' way: muted headings, rules between rows. */
export const TABLE_SX = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
  "& th": { textAlign: "left", color: "text.secondary", fontWeight: 500, py: 1.25, pr: 2, borderBottom: 1, borderColor: "divider", whiteSpace: "nowrap" },
  "& td": { py: 1.5, pr: 2, borderBottom: 1, borderColor: "divider", verticalAlign: "top" },
  "& tr:last-child td": { borderBottom: 0 },
} as const;
