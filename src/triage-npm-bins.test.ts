import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binNames, npxBinCheck, recordNpxBins, type NpxBinDeps } from "./triage-npm-bins.js";
import type { RegistryDoc } from "./triage-cooling.js";
import { gateInstall } from "./triage-gate.js";

// kit-research metaharness-artex-defense-vs-kit. Example registry answers, stubbed: no network.
const REGISTRY: Record<string, RegistryDoc> = {
  "/@metaharness/redblue": {
    status: 200,
    body: { versions: { "0.1.8": { bin: { redblue: "dist/cli.js" } } } },
  },
  "/@metaharness/artex-defense": {
    status: 200,
    body: { versions: { "0.1.0": { bin: { "artex-defense": "cli.mjs" } } } },
  },
  "/redblue": {
    status: 200,
    body: {
      "dist-tags": { latest: "0.0.1" },
      maintainers: [{ name: "someone-else" }],
      time: { created: "2017-02-03T10:00:00.000Z" },
    },
  },
  "/artex-defense": { status: 404, body: null },
  "/prettier": { status: 200, body: { versions: { "3.3.3": { bin: "bin/prettier.cjs" } } } },
};

function stub(air = false): NpxBinDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    env: { KIT_NPM_REGISTRY: "https://registry.example" },
    airGap: async () => ({ enabled: air, mirrors: {} }),
    getDoc: async (url) => {
      const path = url.replace("https://registry.example", "");
      asked.push(path);
      return REGISTRY[path] ?? null;
    },
  };
}

const report = (version: string) => ({
  passed: true,
  output: `  . triaged ${version}, 3 versions\nHealth score: 88/100\nCritical issues: 0\nWarnings: 1\nTRIAGE PASSED`,
});

describe("triage npm: the bin names npx would fetch", () => {
  it("reports a bin owned by another package, with its maintainers and creation date", async () => {
    const r = await npxBinCheck("/p", "@metaharness/redblue", report("0.1.8"), stub());
    assert.deepEqual(
      r.npxBins.map((f) => [f.bin, f.state]),
      [["redblue", "other"]],
    );
    assert.match(r.output, /WARNING: npx redblue: .* runs the other npm package redblue@0\.0\.1/);
    assert.match(r.output, /maintainers someone-else, created 2017-02-03/);
    assert.match(r.output, /npx -p @metaharness\/redblue redblue/);
    assert.match(r.output, /^Warnings: 2$/m);
    assert.equal(r.passed, true, "the package's own verdict does not change");
  });

  it("reports an unclaimed bin name (registry 404)", async () => {
    const r = await npxBinCheck("/p", "@metaharness/artex-defense@0.1.0", report("0.1.0"), stub());
    assert.equal(r.npxBins[0]?.state, "unclaimed");
    assert.match(r.output, /nobody has registered and anyone can claim/);
  });

  it("says `same` for a bin that is the package's own name, and asks nothing more", async () => {
    const deps = stub();
    const r = await npxBinCheck("/p", "prettier", report("3.3.3"), deps);
    assert.deepEqual(r.npxBins, [{ bin: "prettier", package: "prettier", state: "same" }]);
    assert.deepEqual(deps.asked, ["/prettier"]);
    assert.doesNotMatch(r.output, /WARNING: npx/);
  });

  it("says NOT CHECKED under air-gap with no mirror, never a clean line", async () => {
    const deps = { ...stub(true), env: {} };
    const r = await npxBinCheck("/p", "@metaharness/redblue", report("0.1.8"), deps);
    assert.match(r.output, /NOT CHECKED: npx bin names -- air-gap is on/);
    assert.deepEqual(r.npxBins, []);
  });

  it("reads a string `bin` as the package name without its scope", () => {
    assert.deepEqual(binNames("@s/tool", { bin: "cli.js" }), ["tool"]);
    assert.deepEqual(binNames("x", { bin: ["no"] }), []);
  });
});

describe("triage npm: npm-bin records for the gate", () => {
  it("writes `other` and `unclaimed` facts, never `same`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-npm-bin-"));
    try {
      const facts = [
        { bin: "redblue", package: "@metaharness/redblue", state: "other" as const },
        { bin: "prettier", package: "prettier", state: "same" as const },
      ];
      assert.equal(await recordNpxBins(dir, facts), true);
      const rows = readFileSync(join(dir, ".kit-triage.jsonl"), "utf8").trim().split("\n");
      assert.equal(rows.length, 1);
      const row = JSON.parse(rows[0]!) as Record<string, unknown>;
      assert.equal(row.type, "npm-bin");
      assert.equal(row.target, "redblue");
      assert.equal(row.package, "@metaharness/redblue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateInstall: bin facts are recorded whatever the verdict", () => {
  it("records them when cooling holds the scoped package back, as it did in the note", async () => {
    const recorded: string[] = [];
    const v = await gateInstall("npm:@metaharness/redblue", {
      runTriage: async (type, target) => ({
        type,
        target,
        passed: false,
        output: "TRIAGE HELD: cooling period",
        npxBins: [{ bin: "redblue", package: "@metaharness/redblue", state: "other" }],
      }),
      recordBins: async (facts) => recorded.push(...facts.map((f) => f.bin)),
    });
    assert.equal(v.decision, "blocked");
    assert.deepEqual(recorded, ["redblue"]);
  });
});
