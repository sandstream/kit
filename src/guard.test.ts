import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUARD_TOOLS,
  generateShim,
  writeShim,
  rcBlock,
  upsertRcBlock,
  stripRcBlock,
  appendObservation,
  readObservations,
  SHIM_MARKER,
  RC_BEGIN,
  RC_END,
} from "./guard.js";

// kit guard v1 (observe): the shim's contract is FAIL-OPEN by construction —
// it may observe, it must never block or break the real tool. These tests pin
// that contract in the generated text and the file-handling rules.

describe("generateShim", () => {
  const shim = generateShim("npm", "/home/u/.kit/shims");

  it("carries the marker, the bypass knob, and the observe call — in that order of defense", () => {
    assert.ok(shim.includes(SHIM_MARKER));
    assert.ok(shim.includes("KIT_GUARD_BYPASS"));
    assert.ok(shim.includes("kit guard-observe npm"));
  });

  it("observation is silenced AND || true — a kit crash cannot break npm", () => {
    assert.ok(shim.includes('guard-observe npm "$@" >/dev/null 2>&1 || true'));
  });

  it("execs the real binary from PATH, skipping the shims dir; missing binary exits 127", () => {
    assert.ok(shim.includes('[ "${_d}" = "${_kit_shims}" ] && continue'));
    assert.ok(shim.includes('exec "${_d}/npm" "$@"'));
    assert.ok(shim.includes("exit 127"));
  });

  it("only observes when kit is actually on PATH (fresh machine ⇒ pure pass-through)", () => {
    assert.ok(shim.includes("command -v kit >/dev/null"));
  });
});

describe("shim + rc file handling", () => {
  it("writeShim refuses to clobber a file the user authored", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-"));
    try {
      writeFileSync(join(dir, "npm"), "#!/bin/sh\necho my own wrapper\n");
      assert.equal(writeShim("npm", dir), "kept-foreign");
      assert.ok(readFileSync(join(dir, "npm"), "utf-8").includes("my own wrapper"));
      assert.equal(writeShim("brew", dir), "written");
      assert.ok(readFileSync(join(dir, "brew"), "utf-8").includes(SHIM_MARKER));
      // kit-managed files ARE overwritable (idempotent re-install)
      assert.equal(writeShim("brew", dir), "written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upsertRcBlock appends once and replaces in place on re-run", () => {
    const block = rcBlock("/x/shims");
    const first = upsertRcBlock("# my rc\n", block);
    assert.ok(first.includes(RC_BEGIN) && first.includes(RC_END));
    const second = upsertRcBlock(first, rcBlock("/y/shims"));
    assert.equal(second.match(/BEGIN kit guard/g)?.length, 1, "no duplicate blocks");
    assert.ok(second.includes("/y/shims") && !second.includes("/x/shims"));
    assert.ok(second.startsWith("# my rc"), "content outside the markers untouched");
  });

  it("stripRcBlock removes the block and leaves the rest byte-stable", () => {
    const content = upsertRcBlock("# mine\nalias ll='ls -l'\n", rcBlock("/x"));
    const stripped = stripRcBlock(content);
    assert.ok(!stripped.includes("kit guard"));
    assert.ok(stripped.includes("alias ll='ls -l'"));
    assert.equal(stripRcBlock(stripped), stripped, "idempotent on clean content");
  });
});

describe("observation log", () => {
  it("appends and reads back; corrupt rows are skipped, never thrown", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-guard-log-"));
    const saved = process.env.KIT_GUARD_LOG;
    process.env.KIT_GUARD_LOG = join(dir, "obs.jsonl");
    try {
      appendObservation({
        ts: "2026-07-30T00:00:00Z",
        cwd: "/p",
        tool: "npx",
        command: "npx evil",
        wouldBlock: true,
        reason: "triage did not pass",
        refs: ["npm:evil"],
      });
      writeFileSync(
        join(dir, "obs.jsonl"),
        readFileSync(join(dir, "obs.jsonl"), "utf-8") + "{corrupt\n",
      );
      const obs = readObservations();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].wouldBlock, true);
      assert.deepEqual(obs[0].refs, ["npm:evil"]);
    } finally {
      if (saved === undefined) delete process.env.KIT_GUARD_LOG;
      else process.env.KIT_GUARD_LOG = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing log reads as empty (fresh machine)", () => {
    const saved = process.env.KIT_GUARD_LOG;
    process.env.KIT_GUARD_LOG = join(tmpdir(), "kit-guard-nope", "missing.jsonl");
    try {
      assert.deepEqual(readObservations(), []);
    } finally {
      if (saved === undefined) delete process.env.KIT_GUARD_LOG;
      else process.env.KIT_GUARD_LOG = saved;
    }
  });
});

describe("coverage roster", () => {
  it("the fetch-and-run family is on the roster — npx-shaped tools above all", () => {
    for (const t of ["npx", "bunx", "pipx", "uvx", "npm", "bun", "brew", "pip"]) {
      assert.ok(GUARD_TOOLS.includes(t), `${t} missing from GUARD_TOOLS`);
    }
    assert.ok(!existsSync("/nonexistent"), "sanity");
  });
});
