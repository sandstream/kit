import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { checkBrowserScripts, inventoryBrowserScripts } from "./check-browser-scripts.js";
import { ruleForCheck } from "./rules/catalog.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-browser-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(path: string, content: string) {
      const target = join(root, ...path.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
  };
}

const OPTIMIZELY = '<script src="https://cdn.optimizely.com/js/1.js"></script>';
const CARD_FORM = '<form><input name="cardnumber"><input name="cvc"></form>';
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\'">';
const PINNED_SRI =
  '<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="sha384-x" crossorigin="anonymous"></script>';

describe("browser scripts: payment pages", () => {
  it("fails when a third-party script sits on a page with a card form", async (t) => {
    const f = fixture(t);
    f.put(
      "public/checkout.html",
      `<html><head>${OPTIMIZELY}</head><body>${CARD_FORM}</body></html>`,
    );
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "fail");
    assert.equal(row.severity, "high");
    assert.match(row.detail, /public\/checkout\.html loads cdn\.optimizely\.com/);
    assert.match(row.suggestion ?? "", /hosted fields/);
    assert.deepEqual(row.files, ["public/checkout.html"]);
  });

  it("counts scripts in a Next.js _document against every card page", async (t) => {
    const f = fixture(t);
    f.put("pages/_document.tsx", `export default () => <Html><Head>${OPTIMIZELY}</Head></Html>;`);
    f.put("pages/checkout.tsx", `export default () => <input autoComplete="cc-number" />;`);
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "fail");
    assert.match(row.detail, /pages\/checkout\.tsx \(via pages\/_document\.tsx\)/);
  });

  it("does not fail for the payment provider's own script or a card form with no third party", async (t) => {
    const f = fixture(t);
    f.put(
      "checkout.html",
      `${CSP_META}<script src="https://js.stripe.com/v3/"></script>${CARD_FORM}`,
    );
    f.put("about.html", `${OPTIMIZELY}<p>no form</p>`);
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "pass");
    assert.match(row.detail, /2 external script\(s\) from 2 origin\(s\); CSP found/);
  });
});

describe("browser scripts: CDN pinning and SRI", () => {
  it("warns on a mutable CDN reference", async (t) => {
    const f = fixture(t);
    f.put("index.html", `${CSP_META}<script src="https://unpkg.com/lucide@latest"></script>`);
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "warn");
    assert.equal(row.severity, "medium");
    assert.match(row.detail, /mutable CDN URL: index\.html unpkg\.com @latest/);
  });

  it("warns low on a pinned CDN file without integrity", async (t) => {
    const f = fixture(t);
    f.put(
      "index.html",
      `${CSP_META}<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>`,
    );
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "warn");
    assert.equal(row.severity, "low");
    assert.match(row.detail, /pinned without integrity: index\.html unpkg\.com/);
  });

  it("passes with a count when every script is pinned with integrity", async (t) => {
    const f = fixture(t);
    f.put("index.html", `${PINNED_SRI}<script src="/static/app.js"></script>`);
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "pass");
    assert.equal(row.detail, "1 external script(s), all pinned with integrity");
  });
});

describe("browser scripts: CSP", () => {
  it("warns when third-party scripts exist and no CSP is found", async (t) => {
    const f = fixture(t);
    f.put("index.html", OPTIMIZELY);
    f.put("next.config.js", "module.exports = { async headers() { return [] } };");
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "warn");
    assert.match(row.detail, /no Content-Security-Policy found for 1 third-party origin/);
    assert.match(row.suggestion ?? "", /connect-src/);
  });

  for (const [file, text] of [
    [
      "next.config.mjs",
      "headers: [{ key: 'Content-Security-Policy', value: \"default-src 'self'\" }]",
    ],
    ["vercel.json", '{"headers":[{"headers":[{"key":"Content-Security-Policy","value":"x"}]}]}'],
    ["netlify.toml", '[[headers]]\n  [headers.values]\n  Content-Security-Policy = "x"'],
    ["public/_headers", "/*\n  Content-Security-Policy: default-src 'self'"],
    ["server.ts", "app.use(helmet());"],
  ]) {
    it(`finds a CSP in ${file}`, async (t) => {
      const f = fixture(t);
      f.put("index.html", OPTIMIZELY);
      f.put(file, text);
      assert.equal((await checkBrowserScripts(f.root)).status, "pass");
    });
  }
});

describe("browser scripts: scope and bounds", () => {
  it("skips when only same-origin scripts exist, and is cited as CWE-829", async (t) => {
    const f = fixture(t);
    f.put("index.html", '<script src="/app.js"></script><script src="./b.js"></script>');
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "skip");
    assert.equal(ruleForCheck(row.name)?.id, "CWE-829");
  });

  it("never reads generated, vendored or test directories", async (t) => {
    const f = fixture(t);
    for (const dir of ["node_modules/x", "dist", "build", ".next", "vendor", ".git", "__tests__"])
      f.put(`${dir}/index.html`, OPTIMIZELY);
    f.put("src/page.test.tsx", OPTIMIZELY);
    assert.equal((await checkBrowserScripts(f.root)).status, "skip");
  });

  it("reports an oversized page or the file cap as an incomplete scan, never a pass", (t) => {
    const f = fixture(t);
    f.put("big.html", "x".repeat(2048));
    for (let i = 0; i < 4; i++) f.put(`p${i}.html`, "<p></p>");
    const small = inventoryBrowserScripts(f.root, {
      maxFiles: 100,
      maxFileBytes: 1024,
      maxDepth: 16,
    });
    assert.deepEqual(small.errors, ["over 1 KB: big.html"]);
    const capped = inventoryBrowserScripts(f.root, {
      maxFiles: 2,
      maxFileBytes: 4096,
      maxDepth: 16,
    });
    assert.deepEqual(capped.errors, ["file limit reached (2)"]);
  });

  it("turns an incomplete clean scan into a did-not-run warning", async (t) => {
    const f = fixture(t);
    f.put("big.html", `${PINNED_SRI}${"x".repeat(300 * 1024)}`);
    const row = await checkBrowserScripts(f.root);
    assert.equal(row.status, "warn");
    assert.equal(row.didNotRun, true);
    assert.match(row.detail, /1 path\(s\) not scanned: over 256 KB: big\.html/);
  });

  it("ignores an oversized .js bundle, which is not markup", async (t) => {
    const f = fixture(t);
    f.put("public/bundle.js", "x".repeat(300 * 1024));
    assert.equal((await checkBrowserScripts(f.root)).status, "skip");
  });

  it("stops at the depth limit and reports it", (t) => {
    const f = fixture(t);
    f.put("a/b/c/index.html", OPTIMIZELY);
    const inv = inventoryBrowserScripts(f.root, { maxFiles: 100, maxFileBytes: 4096, maxDepth: 1 });
    assert.deepEqual(inv.scripts, []);
    assert.ok(inv.errors.includes("depth limit reached"));
  });

  it("names nested files with forward slashes on every platform", (t) => {
    const f = fixture(t);
    f.put("site/pages/a.html", OPTIMIZELY);
    const inv = inventoryBrowserScripts(f.root);
    assert.deepEqual(
      inv.scripts.map((s) => s.file),
      ["site/pages/a.html"],
    );
  });
});

describe("browser scripts: Next.js layouts", () => {
  it("does not apply _document scripts to static files in public/", (t) => {
    const f = fixture(t);
    f.put("pages/_document.tsx", `export default () => <Html><Head>${OPTIMIZELY}</Head></Html>;`);
    f.put("public/pay.html", `${CSP_META}${CARD_FORM}`);
    return checkBrowserScripts(f.root).then((row) => assert.equal(row.status, "pass"));
  });
});
