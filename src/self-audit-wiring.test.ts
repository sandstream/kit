import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectExportedFunctions,
  isIntentionallyUncalled,
  loadSdkExports,
  readSources,
  analyzeWiring,
  runWiringAudit,
} from "./self-audit-wiring.js";

describe("self-audit-wiring — collectExportedFunctions (pure)", () => {
  it("finds exported and exported-async declarations with 1-based lines", () => {
    const src = [
      "import x from 'y';",
      "export function alpha() {}",
      "export async function beta() {}",
      "function notExported() {}",
    ].join("\n");
    assert.deepEqual(collectExportedFunctions(src, "src/a.ts"), [
      { name: "alpha", file: "src/a.ts", line: 2 },
      { name: "beta", file: "src/a.ts", line: 3 },
    ]);
  });

  it("ignores a non-exported function and an arrow const", () => {
    // Arrow consts are deliberately out of scope: matching them loosely is how this
    // kind of rule starts producing the false positives that make it worthless.
    const src = ["const gamma = () => {};", "export const delta = () => {};"].join("\n");
    assert.deepEqual(collectExportedFunctions(src, "src/a.ts"), []);
  });

  it("does not match an export mentioned mid-line or in a comment", () => {
    const src = ["// export function ghost() {}", "  export function indented() {}"].join("\n");
    assert.deepEqual(collectExportedFunctions(src, "src/a.ts"), []);
  });
});

describe("self-audit-wiring — isIntentionallyUncalled (pure)", () => {
  const sdk = new Set(["isReadOnlyMode"]);

  it("excludes underscore-prefixed and ForTests seams", () => {
    assert.equal(isIntentionallyUncalled("_resetForTests", sdk), true);
    assert.equal(isIntentionallyUncalled("resetConsumedElevationForTests", sdk), true);
  });

  it("excludes declared adapter-SDK exports — plugins call those from outside", () => {
    assert.equal(isIntentionallyUncalled("isReadOnlyMode", sdk), true);
  });

  it("does not excuse an ordinary name", () => {
    assert.equal(isIntentionallyUncalled("resolveMemoryClass", sdk), false);
  });
});

describe("self-audit-wiring — loadSdkExports", () => {
  it("reads the adapterSdk export list", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-wire-sdk-"));
    try {
      mkdirSync(join(root, "contracts"), { recursive: true });
      writeFileSync(
        join(root, "contracts", "public-surface.json"),
        JSON.stringify({ adapterSdk: { exports: ["a", "b"] } }),
        "utf-8",
      );
      assert.deepEqual([...loadSdkExports(root)].sort(), ["a", "b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty set when the contract is missing — excludes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-wire-nosdk-"));
    try {
      assert.equal(loadSdkExports(root).size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty set rather than throwing on unparsable JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-wire-badsdk-"));
    try {
      mkdirSync(join(root, "contracts"), { recursive: true });
      writeFileSync(join(root, "contracts", "public-surface.json"), "{ not json", "utf-8");
      assert.equal(loadSdkExports(root).size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-wiring-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return root;
}

describe("self-audit-wiring — readSources", () => {
  it("splits production from tests and skips node_modules", () => {
    const root = makeRepo({
      "src/a.ts": "export function a() {}",
      "src/a.test.ts": "a();",
      "src/node_modules/dep/b.ts": "export function b() {}",
    });
    try {
      const { production, testText } = readSources(root);
      assert.deepEqual(
        production.map((p) => p.file),
        ["src/a.ts"],
      );
      assert.match(testText, /a\(\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("self-audit-wiring — analyzeWiring", () => {
  it("does not flag a function called from another module", () => {
    const root = makeRepo({
      "src/a.ts": "export function wired() {}",
      "src/b.ts": 'import { wired } from "./a.js";\nwired();',
    });
    try {
      assert.deepEqual(analyzeWiring(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a helper used only inside its own module — that is normal code", () => {
    const root = makeRepo({
      "src/a.ts": ["export function helper() {}", "export function entry() { helper(); }"].join(
        "\n",
      ),
      "src/b.ts": 'import { entry } from "./a.js";\nentry();',
    });
    try {
      assert.deepEqual(
        analyzeWiring(root).map((f) => f.name),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags the classified-memory shape: exported, TESTED, zero production callers", () => {
    // The finding this rule was written for. A green unit test is not proof a feature
    // is reachable, so testedOnly must be true AND it must still be reported.
    const root = makeRepo({
      "src/class.ts": "export function resolveMemoryClass() {}",
      "src/class.test.ts": "resolveMemoryClass();",
    });
    try {
      const found = analyzeWiring(root);
      assert.equal(found.length, 1);
      assert.equal(found[0].name, "resolveMemoryClass");
      assert.equal(found[0].testedOnly, true);
      assert.equal(found[0].line, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes plain dead code from the tested-but-unwired shape", () => {
    const root = makeRepo({
      "src/a.ts": [
        "export function deadEverywhere() {}",
        "export function deadButTested() {}",
      ].join("\n"),
      "src/a.test.ts": "deadButTested();",
    });
    try {
      const byName = new Map(analyzeWiring(root).map((f) => [f.name, f.testedOnly]));
      assert.equal(byName.get("deadEverywhere"), false);
      assert.equal(byName.get("deadButTested"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours the exclusions", () => {
    const root = makeRepo({
      "contracts/public-surface.json": JSON.stringify({ adapterSdk: { exports: ["sdkThing"] } }),
      "src/a.ts": [
        "export function _resetThing() {}",
        "export function thingForTests() {}",
        "export function sdkThing() {}",
      ].join("\n"),
    });
    try {
      assert.deepEqual(analyzeWiring(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("self-audit-wiring — runWiringAudit", () => {
  it("passes when everything is wired", () => {
    const root = makeRepo({
      "src/a.ts": "export function wired() {}",
      "src/b.ts": "wired();",
    });
    try {
      const res = runWiringAudit(root);
      assert.equal(res.length, 1);
      assert.equal(res[0].status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits one advisory row per finding, each with a navigable file:line", () => {
    // Row-per-finding is deliberate: the advisory renderer prints the row COUNT per
    // category, so the count becomes the metric instead of "1 advisory findings".
    const root = makeRepo({
      "src/a.ts": ["export function one() {}", "export function two() {}"].join("\n"),
    });
    try {
      const res = runWiringAudit(root);
      assert.equal(res.length, 2);
      for (const r of res) {
        assert.equal(r.status, "warn");
        assert.equal(r.severity, "low", "advisory — must never gate --fail-on-warning");
        assert.equal(r.category, "self-audit/unwired-code");
        assert.match(r.files![0], /^src\/a\.ts:\d+$/);
      }
      assert.match(res[0].detail, /referenced nowhere in production/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says 'TESTED but no production call site' for the dangerous tier", () => {
    const root = makeRepo({
      "src/a.ts": "export function looksDone() {}",
      "src/a.test.ts": "looksDone();",
    });
    try {
      assert.match(runWiringAudit(root)[0].detail, /TESTED but has no production call site/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a pass rather than throwing when src/ does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-wire-empty-"));
    try {
      assert.equal(runWiringAudit(root)[0].status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
