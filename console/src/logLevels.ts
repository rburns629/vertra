// SPDX-License-Identifier: MIT
/**
 * Who sees which of a step's log lines (decided 2026-10-21): INFO lines to
 * everyone who can see the run; DEBUG, WARN and ERROR to the step's team
 * (and admins). A step logs JSON lines with a `level` (or `severity`); a
 * plain line counts as DEBUG, so nothing reaches a consumer by accident.
 * Credentials a step prints are redacted by the kernel before storage.
 */

/** Pino's number for info. */
const PINO_INFO = 30;

/** Whether a line is meant for everyone who can see the run. */
export function isInfo(line: string): boolean {
  const start = line.indexOf("{");
  if (start < 0 || start > 40) return false; // a timestamp prefix at most
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const { level, severity } = parsed as { level?: unknown; severity?: unknown };
  const value = level ?? severity;
  if (typeof value === "number") return value === PINO_INFO;
  return typeof value === "string" && value.toLowerCase() === "info";
}

/** The lines a caller may see, and how many were held back. */
export function visibleLines(lines: string[], seesEverything: boolean): { lines: string[]; hidden: number } {
  if (seesEverything) return { lines, hidden: 0 };
  const shown = lines.filter(isInfo);
  return { lines: shown, hidden: lines.length - shown.length };
}
