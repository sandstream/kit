import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("excludes compiled tests from every workspace package tarball", () => {
  const packages = join(ROOT, "packages");
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(packages, entry.name, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { files?: string[]; private?: boolean };
    if (pkg.private || !pkg.files?.includes("dist")) continue;
    assert.ok(
      pkg.files.includes("!dist/**/*.test.*"),
      `${entry.name} can publish compiled test artifacts`,
    );
  }
});
