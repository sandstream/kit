import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

/**
 * Files that keep their own inline cleanup. The four large ones sit at their frozen size
 * baseline (an import line would fail the file-size gate), and src/utils is a leaf (ADR-0006)
 * that may not import this helper.
 */
const keepsInlineCleanup = new Set([
  "src/audit.test.ts",
  "src/install-gate.test.ts",
  "src/self-audit-docs.test.ts",
  "src/memory/shared.test.ts",
  "src/utils/exclusive-file.test.ts",
  "src/utils/key-file.test.ts",
]);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("rmTemp", () => {
  it("removes a populated directory and tolerates a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rmtemp-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "file.txt"), "x");
    rmTemp(dir);
    rmTemp(dir);
    assert.throws(() => readdirSync(dir), { code: "ENOENT" });
  });

  it("is the only way tests remove a directory tree (no raw recursive rmSync without retries)", () => {
    const raw = /rmSync\([^;]*?\{\s*recursive: true,\s*force: true\s*\}\)/;
    const offenders = testFiles(srcDir)
      .filter((file) => !file.endsWith("temp-cleanup.test.ts"))
      .filter(
        (file) =>
          !keepsInlineCleanup.has(
            relative(srcDir, file).replaceAll("\\", "/").replace(/^/, "src/"),
          ),
      )
      .filter((file) => raw.test(readFileSync(file, "utf8")));
    assert.deepEqual(
      offenders,
      [],
      "use rmTemp from temp-cleanup.test-support.js: Windows holds files briefly (EBUSY)",
    );
  });
});
