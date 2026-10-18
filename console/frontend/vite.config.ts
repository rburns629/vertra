// SPDX-License-Identifier: MIT
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // The one chunk over Vite's default 500 kB is mermaid's core (~650 kB),
    // fetched only when a Docs guide has a diagram. Anything else this big
    // should still warn.
    chunkSizeWarningLimit: 700,
  },
  server: {
    // In dev, the backend (../src) runs separately on :8080 -- proxying
    // these prefixes makes API calls same-origin as far as the browser is
    // concerned, matching the production shape (the built frontend is
    // served by that same Fastify process, see ../src/index.ts) without
    // needing CORS at all, in dev or prod.
    // One prefix, not one entry per resource -- every real API route
    // lives under /api now (see ../../src/index.ts), specifically so a
    // route can never collide with a same-named frontend page again.
    // The old per-prefix list had already drifted once (no /docs entry,
    // even though console/'s own docs.ts route existed) -- a single shared
    // prefix means there's no longer a list to forget to update.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
