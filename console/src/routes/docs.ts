// SPDX-License-Identifier: MIT
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

// console/docs/*.md, copied into the image (see the Dockerfile): the guides
// for platform teams, shipped with the code they describe, so a deploy can
// never leave them stale. Only user-facing guides go there; the docs for
// people running Acyclix stay in the repo's docs/ and never reach the
// console. Listed by file name, hence the numeric prefixes.
const DOCS_DIR = process.env["DOCS_DIR"] ?? "/app/docs";

interface DocSummary {
  id: string;
  title: string;
}

function titleFromMarkdown(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? fallback;
}

async function listDocs(): Promise<DocSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(DOCS_DIR);
  } catch {
    // No docs folder (e.g. running from source outside the image): an
    // empty list, not an error; nothing else in the console needs it.
    return [];
  }
  const docs: DocSummary[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const content = await readFile(join(DOCS_DIR, entry), "utf-8");
    docs.push({ id: entry.replace(/\.md$/, ""), title: titleFromMarkdown(content, entry) });
  }
  return docs;
}

/** Kept to exactly `[a-zA-Z0-9_-]+` -- this becomes a filesystem path
 * component below, and this is what keeps that safe from traversal
 * without needing to canonicalize/compare resolved paths by hand. */
const DocIdParam = Type.Object({ id: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }) });

/**
 * In-app documentation: the guides in console/docs/. Any authenticated
 * user, no team scoping: it's the same content for everyone, the same
 * "read access isn't scoped like write access" reasoning as products.ts's
 * GET /products.
 */
const docsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/docs", { preHandler: app.authenticate }, async (_request, reply) => {
    reply.send(await listDocs());
  });

  app.get(
    "/docs/:id",
    { schema: { params: DocIdParam }, preHandler: app.authenticate },
    async (request, reply) => {
      try {
        const content = await readFile(join(DOCS_DIR, `${request.params.id}.md`), "utf-8");
        reply.type("text/markdown").send(content);
      } catch {
        reply.code(404).send({ error: "NOT_FOUND", message: "No such doc." });
      }
    },
  );
};

export default docsRoutes;
