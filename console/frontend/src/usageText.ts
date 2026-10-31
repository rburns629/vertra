// SPDX-License-Identifier: MIT
/** How usage reads, the same on Observe's Usage tab and the Teams page. */
import type { TeamUsageView, UsageCount } from "./api";

/** A team as usage names it: "No team" for runs started for none, "itself" for the team being read about. */
export function usageTeam(name: string, self?: string): string {
  if (name === "") return "No team";
  return name === self ? "itself" : name;
}

/** "bots 140 · people 52 · schedules 22", most first, none left out but zeros. */
export function startedBy(t: TeamUsageView): string {
  const parts: [string, number][] = [
    ["bots", t.byBots],
    ["people", t.byPeople],
    ["schedules", t.bySchedules],
  ];
  return parts
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${who} ${n.toLocaleString()}`)
    .join(" · ");
}

/** "growth 280 · itself 162 · identity 12", the first `shown`, then "+n more". */
export function countsText(list: UsageCount[], self?: string, shown = 4): string {
  const head = list.slice(0, shown).map((c) => `${usageTeam(c.name, self)} ${c.count.toLocaleString()}`);
  const more = list.length - shown;
  return head.join(" · ") + (more > 0 ? ` · +${String(more)} more` : "");
}

/** The words for a period of 1, 7 or 30 days, and for the one before it. */
export const PERIOD: Record<1 | 7 | 30, { label: string; before: string }> = {
  1: { label: "24 hours", before: "the day before" },
  7: { label: "7 days", before: "the week before" },
  30: { label: "30 days", before: "the 30 days before" },
};
