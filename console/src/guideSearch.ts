// SPDX-License-Identifier: MIT
/**
 * Searching the guides and the platform's reference docs (guides.ts): what
 * the chat agent answers questions from (decision 24), and what the Docs
 * page's search finds. Each doc is cut into sections at its headings and
 * ranked by BM25 over their words, plus a bonus for each of the question's
 * words in a section's heading, however long the section. Measured against
 * test/docQuestions.ts (docs.test.ts): change the ranking only with it.
 * Keywords, in this process: no service, no model, the same on every cloud.
 * Built once, from the docs in the image (they change only with it).
 */
import { listGuides, readGuide, type GuideKind } from "./guides.js";

export interface Section {
  guide: string;
  title: string;
  kind: GuideKind;
  /** The section's heading, and those it's under: "Upgrading > Databases". */
  heading: string;
  text: string;
}

export interface Hit {
  guide: string;
  title: string;
  kind: GuideKind;
  heading: string;
  excerpt: string;
  score: number;
}

/** A heading word's worth, in idf: about a body's mentioning it twice. */
const HEADING_BONUS = 1.5;

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in is it its me my no not of on or so that the then there this to was what when where which who why will with you your".split(" "),
);

/**
 * What people call the platform's own things, as the docs call them: a
 * question about a password finds the docs about secrets. Few, and only
 * the platform's vocabulary.
 */
const SYNONYMS: Record<string, string> = {
  password: "secret",
  credential: "secret",
  apikey: "secret",
  pipeline: "dag",
  workflow: "dag",
  job: "step",
  task: "step",
  piece: "component",
  part: "component",
};

/** A word's stem: common endings off (testing, tested, tests: test). */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed") && !word.endsWith("eed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** Words: lower case, letters and digits, stemmed, the platform's own names for things. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !STOP.has(w))
    .map(stem)
    .map((w) => SYNONYMS[w] ?? w);
}

/** A doc's sections, cut at its headings (# to ####); the text before the first is its title's. */
export function sectionsOf(guide: string, markdown: string, kind: GuideKind = "guide"): Section[] {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? guide;
  const out: Section[] = [];
  const path: string[] = [];
  let heading = title;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) out.push({ guide, title, kind, heading, text });
    lines = [];
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^(#{1,4})\s+(.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      flush();
      const level = match[1].length;
      path.length = Math.max(0, level - 2);
      if (level > 1) path.push(match[2].trim());
      heading = path.length > 0 ? path.join(" > ") : title;
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

interface Indexed {
  section: Section;
  terms: Map<string, number>;
  heading: Set<string>;
  length: number;
}

export class GuideIndex {
  private readonly docs: Indexed[];
  private readonly frequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(sections: Section[]) {
    this.docs = sections.map((section) => {
      const terms = new Map<string, number>();
      const heading = new Set(words(section.heading));
      const all = [...heading, ...words(section.text)];
      for (const w of all) terms.set(w, (terms.get(w) ?? 0) + 1);
      return { section, terms, heading, length: all.length };
    });
    for (const d of this.docs) for (const w of d.terms.keys()) this.frequency.set(w, (this.frequency.get(w) ?? 0) + 1);
    this.averageLength = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
  }

  /** The best sections for `query`, at most `limit`; design history only with `includeHistory` (a question of why). */
  search(query: string, limit: number, includeHistory = false): Hit[] {
    // Each word, and each two written apart that docs may write as one
    // ("back up": backup, "set up": setup, "sign in": signin).
    const raw = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const joined = raw.slice(1).flatMap((w, i) => words(`${raw[i] ?? ""}${w}`));
    const terms = [...new Set([...words(query), ...joined])];
    if (terms.length === 0) return [];
    const n = this.docs.length;
    const k1 = 1.2;
    // A softer length penalty than BM25's usual 0.75, and a floor: a long
    // section isn't buried, and a two-line one ("Next") doesn't win on
    // brevity alone.
    const b = 0.5;
    const floor = this.averageLength / 2;
    const scored: { d: Indexed; score: number }[] = [];
    for (const d of this.docs) {
      if (d.section.kind === "history" && !includeHistory) continue;
      let score = 0;
      for (const term of terms) {
        const tf = d.terms.get(term);
        if (!tf) continue;
        const df = this.frequency.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * Math.max(d.length, floor)) / this.averageLength));
        // What the section says it's about.
        if (d.heading.has(term)) score += HEADING_BONUS * idf;
      }
      if (score > 0) scored.push({ d, score });
    }
    return scored
      .sort((a, c) => c.score - a.score)
      .slice(0, limit)
      .map(({ d, score }) => ({
        guide: d.section.guide,
        title: d.section.title,
        kind: d.section.kind,
        heading: d.section.heading,
        excerpt: excerpt(d.section.text, terms),
        score: Math.round(score * 100) / 100,
      }));
  }

  /** A section's whole text: the first whose heading contains `heading` (any case). */
  section(guide: string, heading: string): Section | undefined {
    const wanted = heading.toLowerCase();
    return this.docs.find((d) => d.section.guide === guide && d.section.heading.toLowerCase().includes(wanted))?.section;
  }

  /** A doc's headings, in order. */
  headings(guide: string): string[] {
    return this.docs.filter((d) => d.section.guide === guide).map((d) => d.section.heading);
  }
}

/** About 600 characters of `text`, from the paragraph where a term first appears. */
function excerpt(text: string, terms: string[]): string {
  const paragraphs = text.split(/\n\s*\n/);
  const first = paragraphs.findIndex((p) => words(p).some((w) => terms.includes(w)));
  const from = paragraphs.slice(Math.max(0, first)).join("\n\n");
  return from.length > 600 ? `${from.slice(0, 600).trimEnd()}…` : from;
}

let built: Promise<GuideIndex> | undefined;

/** The index of every guide and reference doc in the image, built on first use. */
export function guideIndex(): Promise<GuideIndex> {
  built ??= (async () => {
    const sections: Section[] = [];
    for (const g of await listGuides()) {
      const markdown = await readGuide(g.id);
      if (markdown) sections.push(...sectionsOf(g.id, markdown, g.kind));
    }
    return new GuideIndex(sections);
  })();
  return built;
}
