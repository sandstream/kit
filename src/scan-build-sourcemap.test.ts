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

describe("scanBuildArtifacts source maps", () => {
  it("does not join code in an encoded source map into a secret", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build", "server"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(
        join(dir, "build", "server", "index.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["input.js"],
          sourcesContent: [source],
          mappings: "",
        }),
      );
      assert.deepEqual(await scanBuildArtifacts(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("finds credentials in source maps and keeps source files separate", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7!", "I8j9K0l1", "M2n3O4p5"].join("");
      const map = {
        version: 3,
        sources: ["one.js", "two.js"],
        sourcesContent: [
          'const item = {key: "." + key};\nconsole.log("ordinary code");',
          `const config = {api_key: "${opaque}"};`,
        ],
        mappings: "",
      };
      writeFileSync(join(dir, "build", "client.js.map"), JSON.stringify(map));
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((finding) => finding.label === "keyed-secret"));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanBuildArtifacts source map fields", () => {
  it("scans other map fields and malformed maps", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7", "I8j9K0l1", "M2n3O4p5"].join("");
      writeFileSync(
        join(dir, "build", "valid.js.map"),
        JSON.stringify({ api_key: opaque, sourcesContent: ["safe"] }),
      );
      writeFileSync(join(dir, "build", "broken.js.map"), `{"api_key":"${opaque}"`);
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.deepEqual(error.hits.map((hit) => hit.file).sort(), [
          "build/broken.js.map",
          "build/valid.js.map",
        ]);
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

  it("scans every occurrence of duplicate map fields", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7", "I8j9K0l1", "M2n3O4p5"].join("");
      const source = JSON.stringify(`const config = {api_key: "${opaque}"};`);
      writeFileSync(
        join(dir, "build", "fields.js.map"),
        `{"api_key":"${opaque}","api_key":"safe","sourcesContent":[]}`,
      );
      writeFileSync(
        join(dir, "build", "sources.js.map"),
        `{"sourcesContent":[${source}],"sourcesContent":["safe"]}`,
      );
      const hits = await scanBuildArtifacts(dir);
      assert.deepEqual(hits.map((hit) => hit.file).sort(), [
        "build/fields.js.map",
        "build/sources.js.map",
      ]);
      assert.ok(
        hits.every((hit) => hit.findings.some((finding) => finding.label === "keyed-secret")),
      );
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map encoded metadata and broken JSON", () => {
  it("continues scanning when a keyed value is ambiguous", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const maps = [
        { key: source, custom: secret },
        { sourcesContent: { key: source, custom: secret } },
        { key: source + secret },
      ];
      for (const [index, map] of maps.entries()) {
        writeFileSync(join(dir, "build", `ambiguous${index}.js.map`), JSON.stringify(map));
      }
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.equal(error.hits.length, 3);
        assert.ok(
          error.hits.every((hit) => hit.findings.some((finding) => finding.label === "stripe-key")),
        );
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
  it("reports ambiguous keyed code as incomplete without a false credential", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(join(dir, "build", "metadata.js.map"), JSON.stringify({ key: source }));
      writeFileSync(
        join(dir, "build", "object.js.map"),
        JSON.stringify({ sourcesContent: { key: source } }),
      );
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.deepEqual(error.hits, []);
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map metadata with incomplete JSON", () => {
  it("does not flag safe code in metadata or broken JSON", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(join(dir, "build", "metadata.js.map"), JSON.stringify({ custom: source }));
      const broken = JSON.stringify({ sourcesContent: [source] }).slice(0, -1);
      writeFileSync(join(dir, "build", "broken.js.map"), broken);
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.deepEqual(error.hits, []);
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });

  it("retains a decoded credential from broken JSON", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const broken = JSON.stringify({ sourcesContent: [secret] })
        .replace("sk_" + "live_", "\\u0073k_" + "live_")
        .slice(0, -1);
      writeFileSync(join(dir, "build", "broken.js.map"), broken);
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.ok(error.hits[0].findings.some((finding) => finding.label === "stripe-key"));
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map metadata findings", () => {
  it("detects an encoded credential in a metadata field", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const map = JSON.stringify({ custom: secret, sourcesContent: [] }).replace(
        "sk_" + "live_",
        "\\u0073k_" + "live_",
      );
      writeFileSync(join(dir, "build", "metadata.js.map"), map);
      const hits = await scanBuildArtifacts(dir);
      assert.ok(hits[0].findings.some((finding) => finding.label === "stripe-key"));
    } finally {
      rmTemp(dir);
    }
  });

  it("keeps metadata findings before and after a source limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const sourcesContent = Array<string>(100_001).fill("a");
      for (const [index, map] of [
        { custom: secret, sourcesContent },
        { sourcesContent, custom: secret },
      ].entries()) {
        writeFileSync(join(dir, "build", `metadata${index}.js.map`), JSON.stringify(map));
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

  it("reports invalid maps without a false credential finding", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source =
        'const value = {key: "." + key};\n' +
        'console.log("AlphaBeta0123456789 punctuation and code");\n'.repeat(5);
      writeFileSync(
        join(dir, "build", "mixed.js.map"),
        JSON.stringify({ sourcesContent: [source, {}] }),
      );
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.deepEqual(error.hits, []);
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
});
