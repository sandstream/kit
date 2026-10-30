import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildScanIncompleteError, scanBuildArtifacts } from "./scan-build.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-scan-build-"));
}

describe("scanBuildArtifacts mixed source content", () => {
  it("handles a long unfinished JSON string within the work limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const content = '{"sourcesContent":["' + '\\"'.repeat(100_000);
      writeFileSync(join(dir, "build", "unfinished.js.map"), content);
      const start = performance.now();
      await assert.rejects(scanBuildArtifacts(dir), /source map has invalid JSON/);
      assert.ok(performance.now() - start < 5_000, "scan exceeded the work limit");
    } finally {
      rmTemp(dir);
    }
  });
  it("continues past invalid JSON escapes and retains later credentials", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      writeFileSync(join(dir, "build", "broken.js.map"), `{"bad":"\\q","custom":"${secret}"}`);
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.ok(error.hits[0].findings.some((finding) => finding.label === "stripe-key"));
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
  it("retains decoded findings when source content contains an unexpected object", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source = 'const token = "' + "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123" + '";';
      for (const [index, sourcesContent] of [
        [source, { nested: true }],
        [{ nested: [true, { deep: "value" }] }, source],
      ].entries()) {
        const encoded = JSON.stringify({ sourcesContent }).replace(
          "sk_" + "live_",
          "\\u0073k_" + "live_",
        );
        writeFileSync(join(dir, "build", `mixed${index}.js.map`), encoded);
      }
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.equal(error.hits.length, 2);
        assert.ok(
          error.hits.every((hit) => hit.findings.some((finding) => finding.label === "stripe-key")),
        );
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map metadata and invalid content", () => {
  it("finds generic credentials in malformed object sources", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7!", "I8j9K0l1", "M2n3O4p5"].join("");
      writeFileSync(
        join(dir, "build", "object.js.map"),
        JSON.stringify({ sourcesContent: { api_key: opaque } }),
      );
      writeFileSync(
        join(dir, "build", "array.js.map"),
        JSON.stringify({ sourcesContent: [{ api_key: opaque }] }),
      );
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.equal(error.hits.length, 2);
        assert.ok(
          error.hits.every((hit) =>
            hit.findings.some((finding) => finding.label === "keyed-secret"),
          ),
        );
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map malformed object findings", () => {
  it("finds a credential in non-array object source content", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const map = JSON.stringify({ sourcesContent: { data: secret } }).replace(
        "sk_" + "live_",
        "\\u0073k_" + "live_",
      );
      writeFileSync(join(dir, "build", "object.js.map"), map);
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(
        join(dir, "build", "safe-object.js.map"),
        JSON.stringify({ sourcesContent: { data: source } }),
      );
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.equal(error.hits.length, 1);
        assert.ok(error.hits[0].findings.some((finding) => finding.label === "stripe-key"));
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
  it("reports non-array source content as incomplete without false findings", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(
        join(dir, "build", "string.js.map"),
        JSON.stringify({ sourcesContent: source }),
      );
      writeFileSync(
        join(dir, "build", "boolean.js.map"),
        JSON.stringify({ sourcesContent: false }),
      );
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.match(error.message, /invalid source content/);
        assert.deepEqual(error.hits, []);
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});
