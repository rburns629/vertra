// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionsOf } from "../src/guideSearch.js";
import { caller } from "./rpc.js";

let app: FastifyInstance;
let token: string;
const email = `docs-${randomUUID()}@example.com`;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  token = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  await app.close();
  await db.delete(users).where(inArray(users.email, [email]));
});

const call = caller(() => app);
const listGuides = async () => (await call<{ guides: { id: string; title: string; section: string }[] }>(token, "GuideService/ListGuides")).body.guides;
const getGuide = (id: string, as: string | undefined = token) => call<{ markdown: string }>(as, "GuideService/GetGuide", { id });

describe("the in-app guides", () => {
  it("lists the guides in order, the walkthrough first", async () => {
    const docs = await listGuides();
    expect(docs[0]).toEqual({ id: "01-getting-started", title: "Try Vertra end to end", section: "guides" });
    expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
  });

  it("serves a guide as markdown, and every link between guides resolves", async () => {
    const docs = (await listGuides()).filter((d) => d.section === "guides");
    // The API reference is a page of its own, not a guide file.
    const ids = new Set([...docs.map((d) => d.id), "api-reference"]);
    for (const { id } of docs) {
      const page = await getGuide(id);
      expect(page.code).toBe("ok");
      for (const [, target] of page.body.markdown.matchAll(/\]\(([a-zA-Z0-9_-]+)\.md\)/g)) {
        expect(ids, `${id} links to ${String(target)}`).toContain(target);
      }
    }
  });

  it("refuses anything that isn't a plain guide name", async () => {
    expect((await getGuide("../../package")).code).toBe("invalid_argument");
    expect((await getGuide("no-such-guide")).code).toBe("not_found");
  });

  it("is for signed-in users only", async () => {
    expect((await call(undefined, "GuideService/ListGuides")).code).toBe("unauthenticated");
  });
});

describe("the platform's own docs", () => {
  const sources = readFileSync("docs/reference/SOURCES", "utf-8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/) as [string, string]);

  it("are copies of the repository's, current (make console-docs)", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const [id, path] of sources) {
      const copy = readFileSync(join("docs/reference", `${id}.md`), "utf-8");
      expect(copy === readFileSync(join("..", path), "utf-8"), `console/docs/reference/${id}.md is behind ${path}: run make console-docs`).toBe(true);
    }
  });

  it("are listed after the guides, as the reference", async () => {
    const docs = await listGuides();
    const reference = docs.filter((d) => d.section === "reference");
    expect(reference.map((d) => d.id).sort()).toEqual(sources.map(([id]) => `reference-${id}`).sort());
    expect(docs.findIndex((d) => d.section === "reference")).toBeGreaterThan(docs.findLastIndex((d) => d.section === "guides"));
    expect((await getGuide("reference-operations")).body.markdown).toContain("## Upgrading");
  });
});

describe("searching the docs", () => {
  type Hits = { hits: { guide: string; heading: string; excerpt: string }[] };
  const search = async (query: string) => (await call<Hits>(token, "GuideService/SearchGuides", { query })).body.hits;

  it("finds the section a question is about, in the guides and the reference", async () => {
    // What the agent reads: the best few, not only the first.
    const top = async (query: string) => (await search(query)).slice(0, 3).map((h) => `${h.guide} :: ${h.heading}`);
    expect(await top("how do I back up the databases")).toContain("reference-operations :: Backups");
    expect((await top("what is a DAG")).some((h) => h.startsWith("03-what-is-a-dag"))).toBe(true);
    expect((await top("wiring types types.yaml default provider")).some((h) => h.startsWith("reference-catalog-guide"))).toBe(true);
    expect(await search("zzzz qqqq")).toEqual([]);
  });

  it("refuses an empty question", async () => {
    expect((await call(token, "GuideService/SearchGuides", { query: "" })).code).toBe("invalid_argument");
  });

  it("cuts a doc at its headings, nested, leaving code blocks whole", () => {
    const sections = sectionsOf("g", "# Title\nintro\n## A\na text\n### B\n```\n# not a heading\n```\nb text\n## C\nc");
    expect(sections.map((x) => x.heading)).toEqual(["Title", "A", "A > B", "C"]);
    expect(sections[2]?.text).toContain("# not a heading");
  });
});
