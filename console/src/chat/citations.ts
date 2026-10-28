// SPDX-License-Identifier: MIT
/**
 * Citations in the chat agent's answers (decision 24, Correctness): every
 * section the agent retrieves in a turn is given a source id (S1, S2, ...)
 * when it's handed to the model; the answer cites them as [S1]. Here, the
 * answer's citations are kept only when they name a section retrieved that
 * turn, and each link is built from the search's own result, never from
 * the model's text: a made-up source or link can't reach the person. An
 * answer that searched the docs and cites nothing is flagged as not from
 * the docs.
 */
import type { Hit } from "../guideSearch.js";
import { anchor } from "../guides.js";

export { anchor };

export interface Source extends Hit {
  /** S1, S2, ...: what the answer cites. */
  id: string;
}

export interface Citation {
  id: string;
  guide: string;
  title: string;
  heading: string;
  kind: Hit["kind"];
  /** The console's own page for it: /docs/<guide>#<heading's anchor>. */
  link: string;
}

export interface Checked {
  /** The answer, with any citation of something not retrieved removed. */
  text: string;
  /** What it cites that was retrieved, in the order first cited. */
  citations: Citation[];
  /** Citations of sources not retrieved this turn: removed. */
  invented: string[];
  /** It searched the docs, and cites nothing it found. */
  uncited: boolean;
}


/** Numbers this turn's retrieved sections as sources, after any already given. */
export function asSources(hits: Hit[], already: number): Source[] {
  return hits.map((hit, i) => ({ ...hit, id: `S${String(already + i + 1)}` }));
}

export function linkOf(hit: Pick<Hit, "guide" | "title" | "heading">): string {
  const last = hit.heading.split(" > ").at(-1) ?? "";
  return hit.heading === hit.title ? `/docs/${hit.guide}` : `/docs/${hit.guide}#${anchor(last)}`;
}

/** The answer's citations, checked against what was retrieved. */
export function checkCitations(answer: string, retrieved: Source[]): Checked {
  const byId = new Map(retrieved.map((s) => [s.id, s]));
  const citations: Citation[] = [];
  const invented = new Set<string>();
  const text = answer.replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (whole, ids: string) => {
    const kept = ids
      .split(",")
      .map((id) => id.trim())
      .filter((id) => {
        const source = byId.get(id);
        if (!source) {
          invented.add(id);
          return false;
        }
        if (!citations.some((c) => c.id === id)) {
          citations.push({ id, guide: source.guide, title: source.title, heading: source.heading, kind: source.kind, link: linkOf(source) });
        }
        return true;
      });
    return kept.length > 0 ? `[${kept.join(", ")}]` : "";
  });
  return { text: text.replace(/ +([.,;:])/g, "$1"), citations, invented: [...invented], uncited: retrieved.length > 0 && citations.length === 0 };
}
