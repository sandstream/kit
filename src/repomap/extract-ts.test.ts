import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseImportSpecifiers, resolveImport, isRelativeSpecifier } from "./extract-ts.js";

describe("repomap extract-ts — parseImportSpecifiers", () => {
  it("captures every import form, deduped, order-preserving", () => {
    const src = `
      import a from "./a.js";
      import { b } from "../lib/b";
      import "./side-effect";
      export { c } from "./c";
      const d = require("node:fs");
      const e = await import("./dyn.ts");
      import dup from "./a.js";
    `;
    assert.deepEqual(parseImportSpecifiers(src), [
      "./a.js",
      "../lib/b",
      "./side-effect",
      "./c",
      "node:fs",
      "./dyn.ts",
    ]);
  });

  it("ignores specifiers inside line comments", () => {
    const src = `// import x from "./ignored";\nimport y from "./real";`;
    assert.deepEqual(parseImportSpecifiers(src), ["./real"]);
  });

  it("does not mistake a URL's // for a comment", () => {
    const src = `import y from "./real"; const u = "https://example.com/x";`;
    assert.deepEqual(parseImportSpecifiers(src), ["./real"]);
  });
});

describe("repomap extract-ts — isRelativeSpecifier", () => {
  it("only ./ and ../ are relative", () => {
    assert.ok(isRelativeSpecifier("./x"));
    assert.ok(isRelativeSpecifier("../y"));
    assert.ok(!isRelativeSpecifier("zod"));
    assert.ok(!isRelativeSpecifier("node:fs"));
    assert.ok(!isRelativeSpecifier("@scope/pkg"));
  });
});

describe("repomap extract-ts — resolveImport", () => {
  const fileSet = new Set([
    "src/a.ts",
    "src/lib/b.ts",
    "src/c.tsx",
    "src/dir/index.ts",
    "src/x.js",
  ]);

  it("rewrites a .js ESM specifier to the .ts source", () => {
    assert.equal(resolveImport("src/a.ts", "./lib/b.js", fileSet), "src/lib/b.ts");
  });

  it("resolves an extensionless specifier to .ts/.tsx", () => {
    assert.equal(resolveImport("src/a.ts", "./c", fileSet), "src/c.tsx");
  });

  it("resolves a directory to its index file", () => {
    assert.equal(resolveImport("src/a.ts", "./dir", fileSet), "src/dir/index.ts");
  });

  it("resolves ../ relative to the importer's directory", () => {
    assert.equal(resolveImport("src/lib/b.ts", "../a", fileSet), "src/a.ts");
  });

  it("returns null for a non-relative (external) specifier", () => {
    assert.equal(resolveImport("src/a.ts", "zod", fileSet), null);
    assert.equal(resolveImport("src/a.ts", "node:fs", fileSet), null);
  });

  it("returns null when a relative specifier matches no known file (no guessing)", () => {
    assert.equal(resolveImport("src/a.ts", "./does-not-exist", fileSet), null);
  });
});
