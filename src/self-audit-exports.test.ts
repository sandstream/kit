import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  analyzeExports,
  buildWordIndex,
  collectExports,
  collectReExportAliases,
  entryModules,
  isReferenced,
  runExportsAudit,
  stripReExports,
} from "./self-audit-exports.js";
import { resolveKitRoot } from "./self-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe("self-audit-exports — pure pieces", () => {
  it("collects function, async function, const, let and class exports with lines", () => {
    const src = [
      "export function a() {}",
      "export async function b() {}",
      "export const c = 1;",
      "export let d = 2;",
      "export class E {}",
      "export type T = string;",
      "export interface I {}",
      "export default function f() {}",
    ].join("\n");
    assert.deepEqual(
      collectExports(src, "src/x.ts").map((d) => `${d.name}:${d.line}`),
      ["a:1", "b:2", "c:3", "d:4", "E:5"],
    );
  });

  it("reads a local export list by its exported names", () => {
    const src = ["const a = 1;", "function b() {}", "export {", "  a,", "  b as c,", "};"].join(
      "\n",
    );
    assert.deepEqual(
      collectExports(src, "src/x.ts").map((d) => `${d.name}:${d.line}`),
      ["a:3", "c:3"],
    );
  });

  it("blanks a multi-line re-export but keeps line numbers", () => {
    const src = ["export {", "  x,", "} from './y.js';", "export * from './z.js';", "keep"].join(
      "\n",
    );
    const out = stripReExports(src);
    assert.equal(out.split("\n").length, 5);
    assert.doesNotMatch(out, /\bx\b|from/);
    assert.match(out, /keep/);
  });

  it("indexes words by file, and a re-export line is not a use", () => {
    const index = buildWordIndex([
      { path: "src/a.ts", text: "export function solo() {} export function shared() {}" },
      { path: "src/b.ts", text: "shared(); export { solo } from './a.js';" },
    ]);
    assert.equal(index.get("solo"), 0);
    assert.equal(index.get("shared"), -1);
  });

  it("follows a renamed re-export to its new name", () => {
    const files = [
      { path: "src/a.ts", text: "export function inner() {}\nexport function lonely() {}" },
      { path: "src/b.ts", text: "export { inner as outer, lonely as alone } from './a.js';" },
      { path: "src/c.ts", text: "import { outer } from './b.js'; outer();" },
    ];
    const index = buildWordIndex(files);
    const aliases = collectReExportAliases(files);
    assert.deepEqual(aliases.get("inner"), ["outer"]);
    assert.equal(isReferenced("inner", 0, index, aliases), true);
    assert.equal(isReferenced("lonely", 0, index, aliases), false);
  });
});

describe("self-audit-exports — fixture repository", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "kit-r16-"));
    write(root, "package.json", JSON.stringify({ exports: { ".": "./dist/entry.js" } }));
    write(
      root,
      "contracts/public-surface.json",
      JSON.stringify({ adapterSdk: { exports: ["sdkOnly"] } }),
    );
    write(
      root,
      ".github/kit-protected-paths.json",
      JSON.stringify({
        release: { exact: [], prefix: [] },
        github: { exact: [], prefix: [] },
        secrets: { exact: ["src/guarded.ts"], prefix: [] },
        permissions: { exact: [], prefix: [] },
      }),
    );
    write(
      root,
      "src/lib.ts",
      [
        "export function deadExport() {}",
        "export function usedElsewhere() {}",
        "export const testedOnly = 1;",
        "export function sdkOnly() {}",
        "export function localOnly() { return 1; }",
        "localOnly();",
      ].join("\n"),
    );
    write(root, "src/guarded.ts", "export function guardedDead() {}\n");
    write(root, "src/entry.ts", "export function publicApi() {}\n");
    write(root, "src/lib.test.ts", "import { testedOnly } from './lib.js';\n");
    write(root, "scripts/use.mjs", "usedElsewhere();\n");
  });
  after(() => rmTemp(root));

  it("reads the package entry module from package.json exports", () => {
    assert.deepEqual([...entryModules(root)], ["src/entry.ts"]);
  });

  it("reports the dead and the local-only exports, and nothing referenced or public", () => {
    const got = analyzeExports(root).map((f) => `${f.name}:${f.protectedPath}`);
    assert.deepEqual(got.sort(), ["deadExport:false", "guardedDead:true", "localOnly:false"]);
  });

  it("fails on an unprotected finding and only advises on a protected one", () => {
    const rows = runExportsAudit(root);
    const byName = new Map(rows.map((r) => [r.detail.split(" ")[0], r]));
    assert.equal(byName.get("deadExport")?.status, "fail");
    assert.deepEqual(byName.get("deadExport")?.files, ["src/lib.ts:1"]);
    assert.equal(byName.get("guardedDead")?.status, "warn");
    assert.equal(
      byName.get("guardedDead")?.severity,
      "low",
      "advisory: never gates --fail-on-warning",
    );
  });

  it("passes once nothing is left unreferenced", () => {
    const clean = mkdtempSync(join(tmpdir(), "kit-r16-clean-"));
    try {
      write(clean, "src/a.ts", "export function one() {}\n");
      write(clean, "src/b.ts", "one();\n");
      const rows = runExportsAudit(clean);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "pass");
    } finally {
      rmTemp(clean);
    }
  });
});

describe("self-audit-exports — kit's own tree", () => {
  it("indexes the whole repository in well under the time a per-name regex took", () => {
    const root = resolveKitRoot();
    assert.ok(root);
    const start = Date.now();
    analyzeExports(root!);
    const ms = Date.now() - start;
    assert.ok(ms < 20_000, `analyzeExports took ${ms}ms`);
  });
});
