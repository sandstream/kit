import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIDE_IMPORTERS, importerCounts, widePaths } from "./review-protected-paths-wide.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-wide-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split("/")), body);
  }
  return root;
}

describe("review gate wide lane: importer counts", () => {
  it("counts each non-test importer once, through .js specifiers and subdirectories", (t) => {
    const root = repo({
      "src/config.ts": "export const x = 1;\n",
      "src/a.ts": 'import { x } from "./config.js";\nimport { x as y } from "./config.js";\n',
      "src/sub/b.ts": 'export { x } from "../config.js";\n',
      "src/c.ts": 'const m = await import("./config.js");\n',
      "src/a.test.ts": 'import { x } from "./config.js";\n',
      "src/d.test-support.ts": 'import { x } from "./config.js";\n',
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const counts = importerCounts(root);
    assert.equal(counts.get("src/config.ts"), 3);
  });

  it("measures kit itself: src/config.ts is wide", () => {
    const counts = importerCounts(process.cwd());
    assert.ok((counts.get("src/config.ts") ?? 0) >= WIDE_IMPORTERS);
  });
});

describe("review gate wide lane: changed paths", () => {
  const counts = new Map([
    ["src/config.ts", 132],
    ["src/utils/colors.ts", 83],
    ["src/leaf.ts", 1],
  ]);

  it("returns only paths at or above the threshold, widest first", () => {
    assert.deepEqual(widePaths(["src/leaf.ts", "src/utils/colors.ts", "src/config.ts"], counts), [
      { path: "src/config.ts", importers: 132 },
      { path: "src/utils/colors.ts", importers: 83 },
    ]);
  });

  it("is empty for a change to leaves and unknown files", () => {
    assert.deepEqual(widePaths(["src/leaf.ts", "README.md"], counts), []);
  });
});
