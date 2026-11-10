import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAsarSecrets } from "./scan-build-asar.js";
import { scanBuildArtifacts, type BuildScanReport } from "./scan-build.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Split so the fixture is not itself a key in the source tree.
const KEY = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";

/** An asar-shaped file: a binary size prefix, a JSON header, then a packed file holding `body`. */
function asar(body: string): Buffer {
  const header = JSON.stringify({ files: { "main.js": { size: body.length, offset: "0" } } });
  return Buffer.concat([
    Buffer.from([4, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from(header),
    Buffer.from(body),
  ]);
}

describe("findAsarSecrets", () => {
  it("finds a key packed inside an asar", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-asar-"));
    t.after(() => rmTemp(dir));
    const file = join(dir, "app.asar");
    writeFileSync(file, asar(`const k="${KEY}";`));
    const found = await findAsarSecrets(file, "app.asar");
    assert.ok(Array.isArray(found) && found.some((f) => f.label === "stripe-key"));
  });

  it("finds a key that straddles a window boundary, and reports it once", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-asar-"));
    t.after(() => rmTemp(dir));
    const file = join(dir, "app.asar");
    // Window 64 bytes, overlap 48: the key starts 10 bytes before the first window's end.
    writeFileSync(
      file,
      Buffer.concat([Buffer.alloc(54, 0x20), Buffer.from(`"${KEY}"`), Buffer.alloc(200, 0x20)]),
    );
    const found = await findAsarSecrets(file, "app.asar", { window: 64, overlap: 48 });
    assert.ok(Array.isArray(found));
    assert.equal(found.filter((f) => f.label === "stripe-key").length, 1);
  });
});

describe("scanBuildArtifacts and Electron output", () => {
  it("flags a key in an electron-builder app.asar, which used to pass", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-asar-"));
    t.after(() => rmTemp(dir));
    const resources = join(dir, "dist", "linux-unpacked", "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "app.asar"), asar(`const k="${KEY}";`));
    const hits = await scanBuildArtifacts(dir);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "dist/linux-unpacked/resources/app.asar");
  });

  it("counts the files it did not read, by type", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-asar-"));
    t.after(() => rmTemp(dir));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "main.js"), "ok\n");
    writeFileSync(join(dir, "dist", "x.AppImage"), "binary");
    writeFileSync(join(dir, "dist", "a.node"), "binary");
    writeFileSync(join(dir, "dist", "b.node"), "binary");
    writeFileSync(join(dir, "dist", "LICENSE"), "text");
    const report: BuildScanReport = { skipped: {} };
    await scanBuildArtifacts(dir, undefined, report);
    assert.deepEqual(report.skipped, { ".AppImage": 1, ".node": 2, "(no extension)": 1 });
  });
});
