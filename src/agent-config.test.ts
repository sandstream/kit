import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIT_BLOCK_BEGIN,
  KIT_BLOCK_END,
  upsertKitBlock,
  detectAgentTargets,
  writeAgentConfig,
} from "./agent-config.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-agentcfg-"));
}

describe("upsertKitBlock", () => {
  it("creates a managed block in an empty file", () => {
    const { next, action } = upsertKitBlock("");
    assert.equal(action, "created");
    assert.ok(next.includes(KIT_BLOCK_BEGIN));
    assert.ok(next.includes(KIT_BLOCK_END));
    assert.ok(next.includes("kit triage"));
  });

  it("appends after existing content without clobbering it", () => {
    const { next, action } = upsertKitBlock("# My Project\n\nExisting rules.\n");
    assert.equal(action, "created");
    assert.ok(next.startsWith("# My Project\n\nExisting rules.\n"));
    assert.ok(next.includes(KIT_BLOCK_BEGIN));
  });

  it("is idempotent — re-running an unchanged block is a no-op", () => {
    const once = upsertKitBlock("# Doc\n").next;
    const twice = upsertKitBlock(once);
    assert.equal(twice.action, "unchanged");
    assert.equal(twice.next, once);
  });

  it("updates only the marked region, preserving surrounding edits", () => {
    const base = upsertKitBlock("# Doc\n").next;
    // Simulate a user editing OUTSIDE the markers + a stale block INSIDE.
    const edited = base.replace("kit triage", "STALE_PLACEHOLDER") + "\n## My own section\nkeep me\n";
    const { next, action } = upsertKitBlock(edited);
    assert.equal(action, "updated");
    assert.ok(next.includes("kit triage"), "block refreshed");
    assert.ok(!next.includes("STALE_PLACEHOLDER"), "stale content inside markers replaced");
    assert.ok(next.includes("## My own section"), "content outside markers preserved");
    assert.ok(next.includes("keep me"));
  });

  it("does not duplicate the block on repeated upserts", () => {
    let c = "# Doc\n";
    for (let i = 0; i < 3; i++) c = upsertKitBlock(c).next;
    const begins = c.split(KIT_BLOCK_BEGIN).length - 1;
    assert.equal(begins, 1);
  });
});

describe("detectAgentTargets", () => {
  it("defaults to CLAUDE.md + AGENTS.md when nothing is present", () => {
    const dir = tmpRepo();
    try {
      const files = detectAgentTargets(dir).map((t) => t.file).sort();
      assert.deepEqual(files, ["AGENTS.md", "CLAUDE.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Claude Code via an existing .claude/ dir", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["CLAUDE.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Cursor + Cline via their rules files", () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".cursorrules"), "rules\n");
      writeFileSync(join(dir, ".clinerules"), "rules\n");
      const agents = detectAgentTargets(dir).map((t) => t.agent).sort();
      assert.deepEqual(agents, ["Cline", "Cursor"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeAgentConfig", () => {
  it("writes the block to detected targets", async () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"));
      const results = await writeAgentConfig(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].file, "CLAUDE.md");
      assert.equal(results[0].action, "created");
      const written = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      assert.ok(written.includes(KIT_BLOCK_BEGIN) && written.includes(KIT_BLOCK_END));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves an existing CLAUDE.md and appends the block", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# Existing\n\nMy rules.\n");
      await writeAgentConfig(dir, [{ agent: "Claude Code", file: "CLAUDE.md" }]);
      const written = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      assert.ok(written.startsWith("# Existing\n\nMy rules.\n"));
      assert.ok(written.includes(KIT_BLOCK_BEGIN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("second run is unchanged (idempotent on disk)", async () => {
    const dir = tmpRepo();
    try {
      const t = [{ agent: "Claude Code", file: "CLAUDE.md" }];
      await writeAgentConfig(dir, t);
      const after1 = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      const results = await writeAgentConfig(dir, t);
      assert.equal(results[0].action, "unchanged");
      assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), after1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses + does not write in read-only mode", async () => {
    const dir = tmpRepo();
    process.env.KIT_READ_ONLY = "1";
    try {
      const results = await writeAgentConfig(dir, [{ agent: "Claude Code", file: "CLAUDE.md" }]);
      assert.equal(results[0].action, "failed");
      assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
    } finally {
      delete process.env.KIT_READ_ONLY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
