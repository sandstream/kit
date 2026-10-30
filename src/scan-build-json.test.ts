import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildScanIncompleteError, scanBuildArtifacts } from "./scan-build.js";
import { checkBuiltBundleSecrets } from "./check-client-exposure.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-scan-build-"));
}

describe("scanBuildArtifacts source map size and nesting", () => {
  it("reports scalar and array JSON as invalid source maps", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      writeFileSync(join(dir, "build", "null.js.map"), "null");
      writeFileSync(join(dir, "build", "array.js.map"), "[]");
      await assert.rejects(scanBuildArtifacts(dir), (error: unknown) => {
        assert.ok(error instanceof BuildScanIncompleteError);
        assert.equal(error.issues.length, 2);
        return true;
      });
    } finally {
      rmTemp(dir);
    }
  });
  it("scans a large source map without falling back to encoded text", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const source = 'const token = "' + "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123" + '";';
      const sourcesContent = [...Array<string>(50_000).fill("a"), source];
      const encoded = JSON.stringify({ sourcesContent }).replace(
        "sk_" + "live_",
        "\\u0073k_" + "live_",
      );
      writeFileSync(join(dir, "build", "large.js.map"), encoded);
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((finding) => finding.label === "stripe-key"));
    } finally {
      rmTemp(dir);
    }
  });

  it("fails the scan when source maps exceed the entry limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const sourcesContent = Array<string>(100_001).fill("export{}");
      writeFileSync(join(dir, "build", "too-many.js.map"), JSON.stringify({ sourcesContent }));
      await assert.rejects(scanBuildArtifacts(dir), /source map exceeds 100000 source entries/);
    } finally {
      rmTemp(dir);
    }
  });

  it("scans sources in nested map sections", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7", "I8j9K0l1", "M2n3O4p5"].join("");
      const map = {
        sections: [{ map: { sourcesContent: [null, `const x = {api_key: "${opaque}"};`] } }],
      };
      writeFileSync(join(dir, "build", "section.js.map"), JSON.stringify(map));
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((finding) => finding.label === "keyed-secret"));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map scan limit reporting", () => {
  it("reports an incomplete security check when a map exceeds the limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      writeFileSync(
        join(dir, "dist", "large.js.map"),
        JSON.stringify({ sourcesContent: Array<string>(100_001).fill("export{}") }),
      );
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "fail");
      assert.equal(result.didNotRun, true);
      assert.equal(result.scanIncomplete, true);
      assert.equal(result.hasFindings, undefined);
      assert.match(result.detail, /source map exceeds 100000 source entries/);
    } finally {
      rmTemp(dir);
    }
  });

  it("preserves a detected credential when another map is too large", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      writeFileSync(join(dir, "dist", "leak.js"), "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123");
      writeFileSync(join(dir, "dist", "large.js.map"), " ".repeat(5 * 1024 * 1024 + 1));
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "fail");
      assert.equal(result.didNotRun, true);
      assert.equal(result.severity, "critical");
      assert.equal(result.scanIncomplete, true);
      assert.equal(result.hasFindings, true);
      assert.ok(result.files?.includes("dist/leak.js"));
      assert.match(result.detail, /source map exceeds 5 MiB/);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports deeply nested invalid sources as an incomplete scan", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      const nested = '{"sourcesContent":['.repeat(8_000) + "null" + "]}".repeat(8_000);
      writeFileSync(join(dir, "dist", "nested.js.map"), nested);
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "fail");
      assert.equal(result.didNotRun, true);
      assert.match(result.detail, /source map has invalid source content/);
    } finally {
      rmTemp(dir);
    }
  });

  it("finds an encoded credential inside an unexpected source item", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const map = JSON.stringify({ sourcesContent: ["safe", { data: secret }] }).replace(
        "sk_" + "live_",
        "\\u0073k_" + "live_",
      );
      writeFileSync(join(dir, "dist", "mixed.js.map"), map);
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

describe("source map partial findings", () => {
  it("preserves a credential found before the same map reaches its limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      const secret = "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123";
      const sourcesContent = [secret, ...Array<string>(100_000).fill("a")];
      writeFileSync(join(dir, "dist", "large.js.map"), JSON.stringify({ sourcesContent }));
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "fail");
      assert.equal(result.didNotRun, true);
      assert.equal(result.severity, "critical");
      assert.ok(result.files?.includes("dist/large.js.map"));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("source map test fixtures", () => {
  it("excludes incomplete fixtures from the automatic check", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist", "fixtures"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      writeFileSync(join(dir, "dist", "fixtures", "broken.js.map"), "{");
      writeFileSync(join(dir, "dist", "fixtures", "large.js.map"), " ".repeat(5 * 1024 * 1024 + 1));
      writeFileSync(join(dir, "dist", "widget.test.js.map"), "{");
      writeFileSync(
        join(dir, "dist", "widget.spec.mjs.map"),
        JSON.stringify({ sourcesContent: ["sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123"] }),
      );
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "pass");
      assert.match(result.detail, /4 test fixture\(s\) not counted/);
    } finally {
      rmTemp(dir);
    }
  });

  it("still reports a real credential and an incomplete non-fixture map", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist", "fixtures"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
      writeFileSync(join(dir, "dist", "fixtures", "broken.js.map"), "{");
      writeFileSync(join(dir, "dist", "live.js.map"), "{");
      writeFileSync(join(dir, "dist", "leak.js"), "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123");
      const result = await checkBuiltBundleSecrets(dir);
      assert.equal(result.status, "fail");
      assert.equal(result.didNotRun, true);
      assert.equal(result.severity, "critical");
      assert.match(result.detail, /dist\/live\.js\.map/);
      assert.ok(result.files?.includes("dist/leak.js"));
    } finally {
      rmTemp(dir);
    }
  });
});
