import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBuildArtifacts } from "./scan-build.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-scan-build-"));
}

describe("scanBuildArtifacts", () => {
  it("returns empty when no build dir exists", async () => {
    const dir = makeRepo();
    try {
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores build dirs containing only safe content", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next"), { recursive: true });
      writeFileSync(join(dir, ".next", "main.js"), "const x = 'hello world';\n");
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a Stripe key inlined into a Next.js bundle", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "static", "chunks"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "static", "chunks", "page.js"),
        'const k="' + "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123" + '";\n',
      );
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes("page.js"));
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walks multiple known build dirs in one pass", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "out"), { recursive: true });
      writeFileSync(
        join(dir, "dist", "bundle.js"),
        'AKIA0123456789ABCDEF\n',
      );
      writeFileSync(
        join(dir, "out", "index.html"),
        '<meta data-token="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36">\n',
      );
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects customDirs override", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next"), { recursive: true });
      mkdirSync(join(dir, "my-bundle"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "a.js"),
        "sk_"+"live_NotInTheCustomScannedDirsAtAll\n",
      );
      writeFileSync(
        join(dir, "my-bundle", "b.js"),
        "sk_"+"live_AaBbCcDdEeFfGgHhIiJjKkLl\n",
      );
      const hits = await scanBuildArtifacts(dir, ["my-bundle"]);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes("my-bundle"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
