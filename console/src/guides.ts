// SPDX-License-Identifier: MIT
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

// console/docs/*.md, copied into the image (see the Dockerfile): the guides
// for platform teams, shipped with the code they describe, so a deploy can
// never leave them stale. Only user-facing guides go there; the docs for
// people running Vertra stay in the repo's docs/ and never reach the
// console. Listed by file name, hence the numeric prefixes.
const DOCS_DIR = process.env["DOCS_DIR"] ?? "/app/docs";

export interface GuideSummary {
  id: string;
  title: string;
}

/** Kept to exactly `[a-zA-Z0-9_-]+`: an id becomes a path component in
 * readGuide, and this is what keeps that safe from traversal without
 * canonicalizing and comparing resolved paths by hand. */
export const GuideId = Type.String({ pattern: "^[a-zA-Z0-9_-]+$" });

function titleFromMarkdown(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? fallback;
}

export async function listGuides(): Promise<GuideSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(DOCS_DIR);
  } catch {
    // No docs folder (e.g. running from source outside the image): an
    // empty list, not an error; nothing else in the console needs it.
    return [];
  }
  const guides: GuideSummary[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const content = await readFile(join(DOCS_DIR, entry), "utf-8");
    guides.push({ id: entry.replace(/\.md$/, ""), title: titleFromMarkdown(content, entry) });
  }
  return guides;
}

/** A guide's markdown, or undefined if there's none by that id. `id` must
 * match GuideId (checked by the caller). */
export async function readGuide(id: string): Promise<string | undefined> {
  try {
    return await readFile(join(DOCS_DIR, `${id}.md`), "utf-8");
  } catch {
    return undefined;
  }
}
