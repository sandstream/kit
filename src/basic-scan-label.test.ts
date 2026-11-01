import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basicSecretScanFiles } from "./check-security.js";

describe("basicSecretScanFiles: command labels", () => {
  const hit = (file: string, content: string) => `${file}:157:${content}`;

  it("skips a quoted multi-word command label that ends in a secret-like word", () => {
    const files = basicSecretScanFiles([
      hit("src/subcommand-help.ts", `  "mcp set-token": "Headless / paste-token install",`),
    ]);
    assert.deepStrictEqual(files, []);
  });

  it("still flags a quoted single-word key with a literal value", () => {
    const files = basicSecretScanFiles([
      hit("src/config.json", `  "token": "literal-looking-value-0123456789abcdef"`),
    ]);
    assert.deepStrictEqual(files, ["src/config.json"]);
  });

  it("does not hide a real secret that shares the line with a label", () => {
    const files = basicSecretScanFiles([
      hit(
        "src/config.ts",
        `  "mcp set-token": "Headless / paste-token install", "password": "literal-looking-value-0123456789abcdef"`,
      ),
    ]);
    assert.deepStrictEqual(files, ["src/config.ts"]);
  });
});
