// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  // src/gen: generated from proto/ by `make proto`, never edited.
  { ignores: ["dist/**", "node_modules/**", "src/gen/**"] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Fastify's FastifyPluginAsync* types require an async function even
    // when a plugin's registration body doesn't await anything yet (very
    // common — the async shape exists for plugins that eventually will).
    // Not a bug to silence per-line; a real convention mismatch between
    // this rule and how Fastify plugins are typed.
    files: ["src/routes/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
);
