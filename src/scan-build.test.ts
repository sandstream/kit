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

describe("scanBuildArtifacts", () => {
  it("returns empty when no build dir exists", async () => {
    const dir = makeRepo();
    try {
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
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
      rmTemp(dir);
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
      rmTemp(dir);
    }
  });

  it("ignores Next.js server code and its source maps", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "server"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "server", "edge-instrumentation.js.map"),
        JSON.stringify({ sourcesContent: ["https://user:password@www.example.com/"] }),
      );
      writeFileSync(
        join(dir, ".next", "server", "route.js"),
        'const serverKey="' + "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123" + '";\n',
      );

      assert.deepEqual(await scanBuildArtifacts(dir), []);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanBuildArtifacts browser output", () => {
  it("still scans prerendered Next.js HTML sent to browsers", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "server", "app"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "server", "app", "page.html"),
        "<body>" + "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123" + "</body>",
      );

      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, ".next/server/app/page.html");
    } finally {
      rmTemp(dir);
    }
  });

  it("scans prerendered Next.js RSC responses", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "server", "app"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "server", "app", "page.rsc"),
        "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123",
      );

      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, ".next/server/app/page.rsc");
    } finally {
      rmTemp(dir);
    }
  });
});

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

describe("scanBuildArtifacts mixed source content", () => {
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

describe("scanBuildArtifacts source map size and nesting", () => {
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

describe("source map encoded metadata and broken JSON", () => {
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

describe("scanBuildArtifacts credential shapes", () => {
  it("does not treat ordinary client property names as credentials", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "static"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "static", "page.js"),
        'const field={key:"sessionColumns",password:"forgotten"};' +
          'const url="https://example.com/?token=placeholder_token_1234";',
      );

      assert.deepEqual(await scanBuildArtifacts(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("flags an opaque generic key in a client bundle", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "static"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7", "I8j9K0l1", "M2n3O4p5"].join("");
      writeFileSync(join(dir, ".next", "static", "page.js"), `const config={api_key:"${opaque}"};`);

      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "keyed-secret"));
    } finally {
      rmTemp(dir);
    }
  });

  it("flags an opaque token in a client URL", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next", "static"), { recursive: true });
      const opaque = ["A0b1C2d3", "E4f5G6h7", "I8j9K0l1", "M2n3O4p5"].join("");
      writeFileSync(join(dir, ".next", "static", "page.js"), `fetch("/callback?token=${opaque}");`);

      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "url-query-token"));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanBuildArtifacts directory scope", () => {
  it("walks multiple known build dirs in one pass", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "out"), { recursive: true });
      writeFileSync(join(dir, "dist", "bundle.js"), "AKIA0123456789ABCDEF\n");
      writeFileSync(
        join(dir, "out", "index.html"),
        '<meta data-token="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36">\n',
      );
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 2);
    } finally {
      rmTemp(dir);
    }
  });

  it("does not flag a framework manifest's `value` fields (tfstate FP filter)", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next"), { recursive: true });
      // Next.js routes-manifest.json carries `"value":"…"` header/redirect
      // entries that match the tfstate `"value"` rule but are not secrets.
      writeFileSync(
        join(dir, ".next", "routes-manifest.json"),
        JSON.stringify({
          headers: [
            {
              source: "/",
              headers: [{ key: "x-mw", value: "twenty-plus-character-route-value-login" }],
            },
          ],
        }),
      );
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("still flags a real inlined credential alongside a manifest", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "routes-manifest.json"),
        JSON.stringify({ headers: [{ value: "another-twenty-plus-character-value" }] }),
      );
      mkdirSync(join(dir, ".next", "static"), { recursive: true });
      writeFileSync(
        join(dir, ".next", "static", "leak.js"),
        "sk_" + "live_AaBbCcDdEeFfGgHhIiJjKkLl\n",
      );
      const hits = await scanBuildArtifacts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes("leak.js"));
    } finally {
      rmTemp(dir);
    }
  });

  it("respects customDirs override", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".next"), { recursive: true });
      mkdirSync(join(dir, "my-bundle"), { recursive: true });
      writeFileSync(join(dir, ".next", "a.js"), "sk_" + "live_NotInTheCustomScannedDirsAtAll\n");
      writeFileSync(join(dir, "my-bundle", "b.js"), "sk_" + "live_AaBbCcDdEeFfGgHhIiJjKkLl\n");
      const hits = await scanBuildArtifacts(dir, ["my-bundle"]);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes("my-bundle"));
    } finally {
      rmTemp(dir);
    }
  });
});
