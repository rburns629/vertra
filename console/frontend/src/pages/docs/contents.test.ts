// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import SOURCES from "../../../../docs/reference/SOURCES?raw";
import { contentsOf, docTarget, sectionsOf } from "./contents";

// What the console serves (../../../src/guides.ts): its guides, and the reference SOURCES lists.
const guides = Object.keys(import.meta.glob("../../../../docs/*.md")).map((path) => path.split("/").at(-1)?.replace(/\.md$/, "") ?? "");
const reference = SOURCES
  .split("\n")
  .filter((line) => line.trim() && !line.trim().startsWith("#"))
  .map((line) => `reference-${line.split(/\s+/)[0] ?? ""}`);

describe("the docs' contents", () => {
  const served = new Set(["01-getting-started", "06-database-schemas", "api-reference", "reference-setup", "reference-security-model", "reference-clouds-gcp", "reference-catalog-onboarding-with-ai"]);

  it("places every doc the console serves in a category", () => {
    expect(guides.length).toBeGreaterThan(5);
    expect(reference.length).toBeGreaterThan(5);
    const served = [...guides, ...reference].map((id) => ({ id, title: id, section: "guides" as const, kind: "guide" }));
    const more = contentsOf(served).find((c) => c.id === "more");
    expect(more?.entries.map((e) => e.id) ?? []).toEqual([]);
  });

  it("finds the doc a link between docs means, however the repository wrote its path", () => {
    expect(docTarget("security-model.md#guardrails", served)).toBe("/docs/reference-security-model#guardrails");
    expect(docTarget("../setup.md", served)).toBe("/docs/reference-setup");
    expect(docTarget("clouds/gcp.md", served)).toBe("/docs/reference-clouds-gcp");
    expect(docTarget("../console/docs/06-database-schemas.md", served)).toBe("/docs/06-database-schemas");
    expect(docTarget("docs/onboarding-with-ai.md", served)).toBe("/docs/reference-catalog-onboarding-with-ai");
    expect(docTarget("api-reference.md", served)).toBe("/docs/api-reference");
    expect(docTarget("../TODO.md", served)).toBeNull();
  });

  it("lists a doc's sections as rehype-slug anchors them, skipping code", () => {
    const md = "# T\n\n## The `chat` agent\n\n```\n## no\n```\n\n## Backups\n\n## Backups\n";
    expect(sectionsOf(md)).toEqual([
      { title: "The chat agent", anchor: "the-chat-agent" },
      { title: "Backups", anchor: "backups" },
      { title: "Backups", anchor: "backups-1" },
    ]);
  });
});
