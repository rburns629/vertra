// SPDX-License-Identifier: MIT
import type { DocSummary } from "../../api";
import { API_REFERENCE_ID } from "../ApiReference";

/** A doc as the contents list it: its id, and a short name for the side. */
export interface Entry {
  id: string;
  label: string;
  /** Design history: why, not how it works now. */
  history?: boolean;
}

export interface Category {
  id: string;
  title: string;
  /** Who it's for and what's in it, on the docs' home. */
  blurb: string;
  entries: Entry[];
}

/**
 * The docs in the order to read them: getting started, the ideas, then
 * by what you're doing. A doc the console serves that isn't placed here
 * still shows, under More, so a new one is never lost.
 */
const CONTENTS: { id: string; title: string; blurb: string; docs: [string, string][] }[] = [
  {
    id: "start",
    title: "Get started",
    blurb: "Run your first DAG, and learn the one idea everything else builds on.",
    docs: [
      ["01-getting-started", "Try Vertra end to end"],
      ["03-what-is-a-dag", "What's a DAG?"],
    ],
  },
  {
    id: "concepts",
    title: "Concepts",
    blurb: "How values pass between steps, how secrets stay with their team, and what runs where.",
    docs: [
      ["07-how-data-moves", "How values move between steps"],
      ["04-secrets-explained", "Secrets, explained"],
      ["08-under-the-hood", "Under the hood"],
      ["reference-architecture", "Architecture"],
      ["reference-security-model", "Security model"],
    ],
  },
  {
    id: "how-to",
    title: "How-to guides",
    blurb: "Things you'll do once you're running: automate runs and bring in secrets.",
    docs: [
      ["05-calling-the-api", "Call the API from a pipeline"],
      ["02-sync-secrets-gcp", "Sync secrets from Secret Manager"],
    ],
  },
  {
    id: "products",
    title: "Build products",
    blurb: "For platform teams: publish products and templates to the catalog.",
    docs: [
      ["reference-catalog-guide", "The catalog"],
      ["reference-catalog-onboarding-with-ai", "Onboard with an AI assistant"],
      ["reference-clouds-github", "Get GitHub ready"],
    ],
  },
  {
    id: "operate",
    title: "Install and operate",
    blurb: "For admins: set Vertra up, connect your cloud, and run it day to day.",
    docs: [
      ["reference-setup", "Set up Vertra"],
      ["reference-clouds-gcp", "Get Google Cloud ready"],
      ["reference-clouds-aws", "Get AWS ready"],
      ["reference-operations", "Operations"],
    ],
  },
  {
    id: "reference",
    title: "Reference",
    blurb: "The API, the database, the code's layout, and why it's built the way it is.",
    docs: [
      [API_REFERENCE_ID, "API reference"],
      ["06-database-schemas", "Database tables"],
      ["reference-repository-map", "Repository map"],
      ["reference-assessment", "Design history"],
    ],
  },
];

/** The first steps, in order, on the docs' home. */
export const START_HERE = ["01-getting-started", "03-what-is-a-dag", "07-how-data-moves", "04-secrets-explained"];

/** The contents for the docs the console serves: each category with those it has, then any not placed. */
export function contentsOf(docs: DocSummary[]): Category[] {
  const served = new Map(docs.map((d) => [d.id, d]));
  const placed = new Set<string>();
  const categories: Category[] = [];
  for (const c of CONTENTS) {
    const entries = c.docs
      .filter(([id]) => id === API_REFERENCE_ID || served.has(id))
      .map(([id, label]): Entry => {
        placed.add(id);
        return { id, label, history: served.get(id)?.kind === "history" };
      });
    if (entries.length > 0) categories.push({ id: c.id, title: c.title, blurb: c.blurb, entries });
  }
  const rest = docs.filter((d) => !placed.has(d.id));
  if (rest.length > 0) {
    categories.push({
      id: "more",
      title: "More",
      blurb: "Other guides and reference.",
      entries: rest.map((d) => ({ id: d.id, label: d.title, history: d.kind === "history" })),
    });
  }
  return categories;
}

/** Where a doc is: its category, and the docs before and after it in reading order. */
export function placeOf(categories: Category[], id: string) {
  const order = categories.flatMap((c) => c.entries.map((entry) => ({ entry, category: c })));
  const at = order.findIndex((o) => o.entry.id === id);
  const found = order[at];
  if (!found) return null;
  return { ...found, previous: order[at - 1], next: order[at + 1] };
}

/** A heading's anchor, as rehype-slug makes it (GitHub's). */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A doc's sections (its ## headings, outside code), for "On this page". */
export function sectionsOf(markdown: string): { title: string; anchor: string }[] {
  const sections: { title: string; anchor: string }[] = [];
  // A heading used again gets -1, -2… as rehype-slug numbers it.
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^## (.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) {
      // As it renders: without the markdown around its words.
      const title = heading[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*/g, "");
      const anchor = slug(title);
      const times = seen.get(anchor) ?? 0;
      seen.set(anchor, times + 1);
      sections.push({ title, anchor: times === 0 ? anchor : `${anchor}-${String(times)}` });
    }
  }
  return sections;
}

/**
 * Where a link between docs goes here: "security-model.md#x" is
 * /docs/reference-security-model#x. The link is the repository's path
 * from wherever the doc lives, so it's matched by name: the doc itself,
 * its reference copy, or the one whose id ends with its name
 * ("docs/onboarding-with-ai.md" is reference-catalog-onboarding-with-ai).
 * Null when the console doesn't serve it.
 */
export function docTarget(href: string, served: ReadonlySet<string>): string | null {
  const [path = "", anchor] = href.split("#", 2);
  const name = path
    .replace(/\.md$/, "")
    .replace(/^(\.\.?\/)+/, "")
    .replace(/^(console\/)?docs\//, "")
    .replace(/\//g, "-");
  const base = path.replace(/\.md$/, "").split("/").at(-1) ?? name;
  const id =
    [name, `reference-${name}`, base, `reference-${base}`].find((candidate) => served.has(candidate)) ??
    [...served].find((candidate) => candidate.endsWith(`-${base}`));
  return id ? `/docs/${id}${anchor ? `#${anchor}` : ""}` : null;
}
