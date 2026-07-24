// Lean ESLint for kit — a Node/TypeScript CLI (no React/Next). Catches classes
// of bug `tsc` doesn't (unused vars beyond locals, empty blocks, unsafe `any`,
// case-decl leaks). Type-aware rules (e.g. no-floating-promises) are a deliberate
// follow-up — they need the project service wired across the workspace.
//
// ESM because package.json is `"type": "module"`. Dev-only: never shipped (the
// published package is `files: ["dist", ...]`), so kit's zero-runtime-dep holds.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "**/dist/",
      "node_modules/",
      "**/node_modules/",
      "coverage/",
      "eslint.config.js",
      "**/* 2.ts", // cloud-sync conflict copies (also gitignored)
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Catch genuinely-dead vars/imports (real value); don't nag about unused
      // function parameters — those are usually interface/signature conformance,
      // and TS owns unused locals via noUnusedLocals. `_`-prefixed opts out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" },
      ],
      // `any` and redundant escapes are style/safety hints, not bugs — surface
      // them as warnings (visible backlog to chip away) rather than blocking the
      // gate on ~80 pre-existing dynamic-boundary anys.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-useless-escape": "warn",
      // New in eslint 10's recommended set (this repo moved 9 -> 10 to clear the
      // brace-expansion DoS advisory, GHSA-mh99-v99m-4gvg). Both are legitimate
      // signal, but they flag 43 pre-existing sites — 33 of the
      // `let x = ""; try { x = ... } catch { x = ... }` shape, 10 rethrows
      // missing `{ cause }`. Surfaced as warnings so the security bump stays a
      // pure dependency change; the backlog is visible on every lint run and gets
      // fixed on its own, reviewable pass rather than smuggled in here.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      // This is a terminal CLI — regexes legitimately match ANSI/control chars
      // (e.g. \x1b colour-code stripping). Not a bug class here.
      "no-control-regex": "off",

      // --- Correctness (error — mechanical to fix, prevents real bugs) ---
      eqeqeq: ["error", "smart"], // === / !== (allows == null idiom)
      "no-throw-literal": "error", // always throw Error objects, not strings
      "no-unneeded-ternary": "error",

      // --- Maintainability metrics (warn — genuine tech-debt signal a skilled
      // reviewer WOULD want surfaced, e.g. createMcpServer at ~774 lines, cli.ts
      // size. Kept honest, not silenced; refactored down over time. ---
      complexity: ["warn", 20], // cyclomatic complexity per function
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-depth": ["warn", 4], // nesting depth
      "max-params": ["warn", 5],

      // Deliberately NOT enabled — these flagged clean, intentional patterns in
      // this codebase (noise, not signal), so enabling them would be the wrong
      // kind of strictness:
      //   - no-nested-ternary: the hits were tidy 3-way colour/format pickers.
      //   - no-non-null-assertion: under `strict`, the `!`s are safe-by-construction
      //     (post-bounds-check indexing, map-get after has-check). Churning them
      //     adds risk without removing a real null bug.
    },
  },
  {
    // Type-aware pass — only the two promise rules (not the full typed-recommended,
    // which would add a large new backlog). These catch real bugs an async CLI is
    // prone to: an unawaited promise that silently swallows failures.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // completions.ts generates bash/zsh completion scripts in a template literal
    // where `$` is uniformly escaped (`\$`) — load-bearing for `\${...}` (prevents
    // JS interpolation) and kept on bare `\$x` for a consistent, readable template.
    // De-escaping the bare ones would only create inconsistency + risk.
    files: ["src/completions.ts"],
    rules: { "no-useless-escape": "off" },
  },
  {
    // Zero-LLM invariant, MACHINE-ENFORCED. kit is deterministic and never calls a
    // model — it EMITS prompts for a bring-your-own LLM. That rule was documented in
    // ~35 comments but nothing failed the build if an LLM SDK crept in. This bans the
    // known SDKs in src/ so the most important invariant is enforced like the command
    // contract (public-surface.test.ts), not left to code review. @modelcontextprotocol
    // (MCP transport) is intentionally NOT banned — it is a protocol, not a model client.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "openai",
                "openai/*",
                "@anthropic-ai/sdk",
                "@anthropic-ai/*",
                "@google/generative-ai",
                "@google/genai",
                "@google-cloud/vertexai",
                "cohere-ai",
                "@mistralai/*",
                "groq-sdk",
                "ollama",
                "replicate",
                "langchain",
                "langchain/*",
                "@langchain/*",
                "llamaindex",
                "ai", // Vercel AI SDK
              ],
              message:
                "kit is ZERO-LLM: no LLM SDK may be imported in src/. kit emits prompts for a bring-your-own model; it never calls one. This invariant is enforced, not advisory.",
            },
          ],
        },
      ],
    },
  },
  {
    // Test files: keep correctness rules but exempt the size/complexity metrics —
    // a describe() block is one big "function" + long fixtures are normal there.
    files: ["**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      complexity: "off",
      // node:test's it()/test() return promises by design — not floating bugs.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
);
