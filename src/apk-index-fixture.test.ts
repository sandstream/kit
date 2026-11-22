import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { gzipSync } from "node:zlib";
import { tarOf } from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("builds an APKINDEX fixture that an independent tar reader accepts", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-apk-fixture-"));
  try {
    const archive = join(root, "index.tar.gz");
    const text = "P:libexpat\nV:2.10.0-r0\no:expat\n";
    writeFileSync(archive, gzipSync(tarOf({ DESCRIPTION: "test index", APKINDEX: text })));
    // A relative name from the archive's folder: GNU tar reads `C:\...` as host `C` on Windows.
    const observed = execFileSync("tar", ["-xOzf", "index.tar.gz", "APKINDEX"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(observed, text);
  } finally {
    rmTemp(root);
  }
});
