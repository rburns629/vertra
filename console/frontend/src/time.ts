// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

/** A span of time as people say it: "14s", "8m 05s", "2h 03m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

/** When something happened, relative to today: "today 14:02", "yesterday 16:20", "Oct 12 09:15". */
export function when(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === today.toDateString()) return `today ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** The time now, ticking every second while `live`: for durations still running. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  return now;
}
