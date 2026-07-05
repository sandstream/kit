import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * The zero-LLM invariant, belt-and-suspenders. `eslint.config.js` bans LLM-SDK
 * *imports* in src/ (enforced by `npm run lint` in CI), but two gaps remain that a
 * lint rule alone can't hold: (1) the ban could be silently deleted from the config,
 * and (2) an LLM SDK could be added as a *dependency* (a supply-chain foothold) before
 * anyone imports it. These node:test cases run in the CI gate (`npm test`) and fail on
 * both — so kit's most important invariant is protected like the command surface.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A representative slice of the banned SDKs — enough that removing the eslint rule or
// slipping one in as a dep trips this test. Kept in sync with eslint.config.js.
const BANNED_LLM_SDKS = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "groq-sdk",
  "ollama",
  "replicate",
  "langchain",
  "llamaindex",
];

function depNames(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, Record<string, string>>;
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return fields.flatMap((f) => Object.keys(pkg[f] ?? {}));
}

describe("zero-LLM boundary", () => {
  it("the eslint no-restricted-imports ban is still present (can't be silently removed)", () => {
    const cfg = readFileSync(join(REPO_ROOT, "eslint.config.js"), "utf-8");
    assert.match(
      cfg,
      /no-restricted-imports/,
      "the LLM-SDK import ban must stay in eslint.config.js",
    );
    assert.match(cfg, /ZERO-LLM/i, "the zero-LLM enforcement rule must stay");
    // A few concrete SDKs must remain in the banned list.
    for (const sdk of ["openai", "@anthropic-ai/sdk", "langchain"]) {
      assert.ok(cfg.includes(sdk), `eslint ban must still list ${sdk}`);
    }
  });

  it("no LLM SDK is a declared dependency of the root package", () => {
    const names = depNames(join(REPO_ROOT, "package.json"));
    for (const sdk of BANNED_LLM_SDKS) {
      assert.ok(!names.includes(sdk), `${sdk} must not be a dependency of kit (zero-LLM)`);
    }
  });

  it("no LLM SDK is a declared dependency of any workspace package", () => {
    const pkgsDir = join(REPO_ROOT, "packages");
    if (!existsSync(pkgsDir)) return;
    for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(pkgsDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const names = depNames(pkgPath);
      for (const sdk of BANNED_LLM_SDKS) {
        assert.ok(
          !names.includes(sdk),
          `${sdk} must not be a dependency of packages/${entry.name}`,
        );
      }
    }
  });
});
