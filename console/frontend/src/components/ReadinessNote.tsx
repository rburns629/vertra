// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import type { Readiness } from "../api";
import { useEnvironment } from "../environment";

/** What a check said, in a sentence, when it's something to know: not ready (what it lacks) or couldn't say (why). */
export function readinessSentence(r: Readiness | null, install: string): string | null {
  if (!r) return null;
  if (r.state === "not_ready") {
    const as = r.principal ? `acting as ${r.principal}, ` : "";
    const lacks = r.missing.length > 0 ? `it lacks ${r.missing.join("; ")}` : (r.detail ?? "its check says it isn't");
    return `Not ready on ${install}: ${as}${lacks}.`;
  }
  if (r.state === "failed") return `Its check couldn't say${r.detail ? `: ${r.detail}` : "."}`;
  return null;
}

/**
 * A tinted note on a card for what you should know before running it: not
 * ready here, its check failed, or deprecated (and what to use instead).
 * Nothing when there's nothing to say.
 */
export function ReadinessNote({ readiness, deprecated, children }: { readiness?: Readiness | null; deprecated?: string | null; children?: ReactNode }) {
  const install = useEnvironment()?.label || "this install";
  const sentence = readinessSentence(readiness ?? null, install);
  const text = sentence ?? (deprecated ? `Deprecated: ${deprecated}` : null);
  if (!text) return null;
  const error = readiness?.state === "not_ready";
  return (
    <Box
      sx={{
        fontSize: 12.5,
        lineHeight: 1.45,
        px: 1.25,
        py: 1,
        borderRadius: "6px",
        color: error ? "error.dark" : "warning.main",
        bgcolor: error ? "error.light" : "tint.warningSurface",
        overflowWrap: "anywhere",
        "& a": { color: "inherit" },
      }}
    >
      {text}
      {children && <> {children}</>}
    </Box>
  );
}
