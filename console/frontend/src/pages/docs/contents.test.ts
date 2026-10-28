// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { docTarget, sectionsOf } from "./contents";

describe("the docs' contents", () => {
  const served = new Set(["01-getting-started", "06-database-schemas", "api-reference", "reference-setup", "reference-security-model", "reference-clouds-gcp", "reference-catalog-onboarding-with-ai"]);

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
