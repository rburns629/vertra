// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
/**
 * The docs page draws the console docs' mermaid diagrams (DocsPage.tsx):
 * each must still parse under the mermaid installed, so a major bump that
 * breaks one fails here rather than on the page.
 */
import { expect, it } from "vitest";
import mermaid from "mermaid";

const docs = import.meta.glob<string>("../../docs/*.md", { query: "?raw", import: "default", eager: true });

it("parses every diagram in the console's docs", async () => {
  mermaid.initialize({ startOnLoad: false });
  const failures: string[] = [];
  let count = 0;
  for (const [name, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      count++;
      try {
        await mermaid.parse(m[1] ?? "");
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message.split("\n")[0] ?? ""}`);
      }
    }
  }
  expect(count).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});
