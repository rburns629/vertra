// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

// Unit tests for the frontend's logic. Most need no DOM; a test that renders
// a hook or component opts into jsdom with a `// @vitest-environment jsdom`
// comment at its top.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
  // docsDiagrams.test.ts reads the console's docs (../docs), outside this folder.
  server: { fs: { allow: [".", "../docs"] } },
});
