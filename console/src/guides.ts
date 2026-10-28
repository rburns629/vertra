// SPDX-License-Identifier: MIT
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

// console/docs/*.md, copied into the image (see the Dockerfile): the guides
// for platform teams, shipped with the code they describe, so a deploy can
// never leave them stale. Listed by file name, hence the numeric prefixes.
// And console/docs/reference/: the platform's own docs (architecture,
// operations, the security model, the catalog's guide), copied from the
// repository (`make console-docs`), since the chat agent answers from them
// too (decision 24). The repository is public, so none of it is news; none
// of it holds a credential.
const DOCS_DIR = process.env["DOCS_DIR"] ?? "/app/docs";
const REFERENCE = "reference-";

export interface GuideSummary {
  id: string;
  title: string;
  /** guides: for using Vertra; reference: the platform's own docs. */
  section: "guides" | "reference";
}

/** Kept to exactly `[a-zA-Z0-9_-]+`: an id becomes a path component in
 * readGuide, and this is what keeps that safe from traversal without
 * canonicalizing and comparing resolved paths by hand. */
export const GuideId = Type.String({ pattern: "^[a-zA-Z0-9_-]+$" });

function titleFromMarkdown(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? fallback;
}

async function markdownIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // No docs folder (e.g. running from source outside the image): none,
    // not an error; nothing else in the console needs it.
    return [];
  }
}

export async function listGuides(): Promise<GuideSummary[]> {
  const guides: GuideSummary[] = [];
  for (const [dir, section, prefix] of [
    [DOCS_DIR, "guides", ""],
    [join(DOCS_DIR, "reference"), "reference", REFERENCE],
  ] as const) {
    for (const entry of await markdownIn(dir)) {
      const content = await readFile(join(dir, entry), "utf-8");
      guides.push({ id: prefix + entry.replace(/\.md$/, ""), title: titleFromMarkdown(content, entry), section });
    }
  }
  return guides;
}

/** A guide's markdown, or undefined if there's none by that id. `id` must
 * match GuideId (checked by the caller). */
export async function readGuide(id: string): Promise<string | undefined> {
  const path = id.startsWith(REFERENCE) ? join(DOCS_DIR, "reference", `${id.slice(REFERENCE.length)}.md`) : join(DOCS_DIR, `${id}.md`);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}
