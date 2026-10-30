// SPDX-License-Identifier: MIT
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { Pill, type PillTone } from "../../components/Pill";
import type { LogLineView } from "../../api";

export const LEVEL: Record<string, PillTone> = { debug: "neutral", info: "info", warn: "warning", error: "error" };

/** Oct 30, 14:12:41. */
function stamp(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

/** Where a line came from: a step (linked to its run), an API backend, or the platform. */
function Source({ line: l }: { line: LogLineView }) {
  if (l.executionId) {
    return (
      <>
        {l.team} · {l.task}
        {l.attempt > 1 ? ` (attempt ${String(l.attempt)})` : ""} ·{" "}
        <Link component={RouterLink} to={`/runs/${l.executionId}`} sx={{ fontFamily: "fontFamilyMono", fontSize: 11.5 }}>
          {l.executionId.slice(0, 8)}
        </Link>
      </>
    );
  }
  return <>{l.team ? `${l.team} · ${l.app || "API backend"}` : l.app || "platform"}</>;
}

/**
 * Log lines, newest first, as Observe and an API's page show them: when,
 * level, where from, and the line. Errors and warnings are tinted, and
 * always carry their level in words.
 */
export function LogLines({ lines, sourceWidth = 210 }: { lines: LogLineView[]; sourceWidth?: number }) {
  return (
    <Box sx={{ overflowX: "auto" }}>
      {lines.map((l, i) => (
        <Box
          key={`${l.at ?? ""}/${String(i)}`}
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "auto 1fr", md: `128px 58px ${String(sourceWidth)}px minmax(0, 1fr)` },
            columnGap: 1.5,
            rowGap: 0.5,
            alignItems: "baseline",
            px: 2.75,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
            bgcolor: (theme) => (l.level === "error" ? alpha(theme.palette.error.light, 0.4) : undefined),
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {stamp(l.at)}
          </Typography>
          <Box sx={{ justifySelf: "start" }}>
            <Pill tone={LEVEL[l.level] ?? "neutral"}>{l.level}</Pill>
          </Box>
          <Typography variant="caption" sx={{ lineHeight: 1.45, overflowWrap: "anywhere", gridColumn: { xs: "1 / -1", md: "auto" } }}>
            <Source line={l} />
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              gridColumn: { xs: "1 / -1", md: "auto" },
              fontFamily: "fontFamilyMono",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: l.level === "error" ? "error.main" : l.level === "warn" ? "warning.main" : "text.primary",
            }}
          >
            {l.line}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
