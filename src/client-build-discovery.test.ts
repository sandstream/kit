import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkBuiltBundleSecrets } from "./check-client-exposure.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-client-exp-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("checkBuiltBundleSecrets without a declared framework (kit-research#230)", () => {
  it("scans dist/assets JavaScript although only express is declared", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ dependencies: { express: "4.21.2" } }),
      "dist/assets/index-a1b2c3.js": 'const k="sk_test_0000FAKE0000NOTREAL0000KEY00";\n',
    });
    try {
      const r = await checkBuiltBundleSecrets(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "critical");
      assert.match(r.detail, /dist\/assets\/index-a1b2c3\.js/);
      assert.match(r.detail, /no client framework declared/);
    } finally {
      rmTemp(dir);
    }
  });

  it("passes a clean browser build, and keeps the old skip when there is no build at all", async () => {
    const built = tree({
      "package.json": "{}",
      "build/index.html": "<script src=/static/main.js></script>",
      "build/static/main.js": "console.log(1);\n",
    });
    const bare = tree({ "package.json": "{}" });
    try {
      const r = await checkBuiltBundleSecrets(built);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /build/);
      const s = await checkBuiltBundleSecrets(bare);
      assert.equal(s.status, "skip");
      assert.match(s.detail, /nothing builds for a browser/);
    } finally {
      rmTemp(built);
      rmTemp(bare);
    }
  });
});
