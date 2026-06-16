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
      // This is a terminal CLI — regexes legitimately match ANSI/control chars
      // (e.g. \x1b colour-code stripping). Not a bug class here.
      "no-control-regex": "off",

      // --- Correctness (error — mechanical to fix, prevents real bugs) ---
      eqeqeq: ["error", "smart"], // === / !== (allows == null idiom)
      "no-throw-literal": "error", // always throw Error objects, not strings
      "no-unneeded-ternary": "error",

      // --- Maintainability metrics (warn — surface hotspots without blocking;
      // the existing CLI has known-large modules, e.g. cli.ts, to split over time) ---
      complexity: ["warn", 20], // cyclomatic complexity per function
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-depth": ["warn", 4], // nesting depth
      "max-params": ["warn", 5],
      "no-nested-ternary": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn", // `!` hides real null risk
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
