import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscripts } from "./scan-transcripts.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-scan-tx-"));
}

describe("scanTranscripts", () => {
  it("returns empty when no agent dirs exist", async () => {
    const dir = makeRepo();
    try {
      const hits = await scanTranscripts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("returns empty when transcripts contain no credentials", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        '{"model":"sonnet-4-6","permissions":{"defaultMode":"acceptEdits"}}',
      );
      const hits = await scanTranscripts(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("flags a leaked Stripe key in a .claude transcript", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".claude", "projects"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "projects", "session-1.jsonl"),
        '{"type":"user","content":"My Stripe key is ' +
          "sk_li" +
          "ve_AbCdEfGhIjKlMnOpQrStUv" +
          '"}\n',
      );
      const hits = await scanTranscripts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmTemp(dir);
    }
  });

  it("scans .opencode + .cursor + .aider in addition to .claude", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(join(dir, ".opencode", "history.jsonl"), '{"text":"AKIA0123456789ABCDEF"}\n');
      const hits = await scanTranscripts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes(".opencode"));
    } finally {
      rmTemp(dir);
    }
  });

  it("scans the Codex CLI .codex dir", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      writeFileSync(join(dir, ".codex", "session.jsonl"), '{"text":"AKIA0123456789ABCDEF"}\n');
      const hits = await scanTranscripts(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.includes(".codex"));
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanTranscripts: copies of the repo are not transcripts", () => {
  const KEY = "STRIPE_SECRET_KEY=sk_te" + "st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n";

  it("skips Claude Code's sub-agent worktrees and Next.js build output", async () => {
    const dir = makeRepo();
    try {
      const copy = join(dir, ".claude", "worktrees", "agent-a1b2c3");
      mkdirSync(join(copy, "docs"), { recursive: true });
      mkdirSync(join(copy, ".next"), { recursive: true });
      writeFileSync(join(copy, "docs", "setup.md"), KEY);
      writeFileSync(join(copy, ".next", "routes-manifest.json"), KEY);
      mkdirSync(join(dir, ".next"), { recursive: true });
      writeFileSync(join(dir, ".claude", "keep.md"), "# notes\n");
      assert.deepEqual(await scanTranscripts(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("still flags a credential next to the worktrees folder, and names only that file", async () => {
    const dir = makeRepo();
    try {
      const copy = join(dir, ".claude", "worktrees", "agent-a1b2c3");
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, "setup.md"), KEY);
      writeFileSync(join(dir, ".claude", "session.jsonl"), KEY);
      const hits = await scanTranscripts(dir);
      assert.deepEqual(
        hits.map((h) => h.file),
        [join(dir, ".claude", "session.jsonl")],
      );
    } finally {
      rmTemp(dir);
    }
  });
});
