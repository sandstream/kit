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
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
