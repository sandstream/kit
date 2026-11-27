import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideBashGate } from "./install-gate.js";
import type { GateDeps } from "./triage-gate.js";

// kit-research metaharness-artex-defense-vs-kit: `npx redblue init` passed (exit 0) because the gate
// triaged the unrelated unscoped `redblue` (76/100) instead of the scoped package whose bin it is.
// Example names; nothing here touches the network.
const T0 = "2026-11-20T00:00:00.000Z";
const RECORDS = [
  {
    timestamp: T0,
    type: "npm-bin",
    target: "redblue",
    bin: "redblue",
    package: "@metaharness/redblue",
    state: "other",
    owner: { version: "0.0.1", maintainers: ["someone-else"], created: "2017-02-03" },
  },
  {
    timestamp: T0,
    type: "npm-bin",
    target: "artex-defense",
    bin: "artex-defense",
    package: "@metaharness/artex-defense",
    state: "unclaimed",
  },
];

/** Every triage passes, as the unrelated `redblue` did, so only the bin rule can block. */
function passingDeps(): GateDeps & { triaged: string[] } {
  const triaged: string[] = [];
  return {
    triaged,
    runTriage: async (type, target) => {
      triaged.push(target);
      return { type, target, passed: true, output: "TRIAGE PASSED" };
    },
  };
}

function project(lines: object[], bins: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-npx-bin-"));
  writeFileSync(join(dir, ".kit-triage.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const bin of bins) {
    writeFileSync(join(dir, "node_modules", ".bin", bin), "#!/bin/sh\n");
    writeFileSync(join(dir, "node_modules", ".bin", `${bin}.cmd`), "@echo off\r\n");
  }
  return dir;
}

async function verdict(command: string, dir: string) {
  try {
    return await decideBashGate(command, passingDeps(), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gate-bash: a bin name that belongs to a scoped package", () => {
  it("blocks `npx redblue init` when triage recorded the unscoped name as another package", async () => {
    const v = await verdict("npx redblue init", project(RECORDS));
    assert.equal(v.block, true, v.reason);
    assert.match(v.reason, /bin of @metaharness\/redblue/);
    assert.match(v.reason, /npx -p @metaharness\/redblue redblue/);
    assert.match(v.reason, /redblue@0\.0\.1/);
  });

  it("blocks an unclaimed name even once someone registers it and it triages clean", async () => {
    const v = await verdict("npx artex-defense replay a b c", project(RECORDS));
    assert.equal(v.block, true, v.reason);
    assert.match(v.reason, /not registered, so anyone can claim it/);
    assert.match(v.reason, /npx -p @metaharness\/artex-defense artex-defense/);
  });

  it("covers npm exec, pnpm dlx, yarn dlx and bunx", async () => {
    for (const cmd of [
      "npm exec redblue -- init",
      "pnpm dlx redblue init",
      "yarn dlx redblue init",
      "bunx redblue init",
    ]) {
      const v = await verdict(cmd, project(RECORDS));
      assert.equal(v.block, true, `${cmd}: ${v.reason}`);
    }
  });

  it("allows the bin a local install provides, as the shadow check always did", async () => {
    const v = await verdict("npx redblue init", project(RECORDS, ["redblue"]));
    assert.equal(v.block, false, v.reason);
    const moved = await verdict("cd ../x && npx redblue init", project(RECORDS, ["redblue"]));
    assert.equal(moved.block, true, "a cd voids the shadow, so the record applies");
  });

  it("does not block the scoped spelling, nor a bin that is the package's own name", async () => {
    const scoped = await verdict("npx -p @metaharness/redblue redblue init", project(RECORDS));
    assert.equal(scoped.block, false, scoped.reason);
    const prettier = await verdict("npx prettier --check .", project(RECORDS));
    assert.equal(prettier.block, false, prettier.reason);
    const initiator = await verdict("npm init redblue", project(RECORDS));
    assert.equal(initiator.block, false, "npm init redblue fetches create-redblue, not redblue");
  });

  it("lets a newer PASS for the unscoped name itself through, and only a newer one", async () => {
    const pass = (timestamp: string) => ({
      timestamp,
      type: "npm",
      target: "redblue",
      sandbox: false,
    });
    const newer = await verdict("npx redblue", project([...RECORDS, pass("2026-11-21T00:00:00Z")]));
    assert.equal(newer.block, false, newer.reason);
    const older = await verdict("npx redblue", project([pass("2026-11-19T00:00:00Z"), ...RECORDS]));
    assert.equal(older.block, true, older.reason);
  });

  it("fails closed on a name it cannot resolve, and ignores a record naming no scoped package", async () => {
    const expanded = await verdict("npx $TOOL init", project(RECORDS));
    assert.equal(expanded.block, true, expanded.reason);
    const forged = [{ ...RECORDS[0], package: "redblue" }];
    const v = await verdict("npx redblue init", project(forged));
    assert.equal(v.block, false, v.reason);
  });
});
