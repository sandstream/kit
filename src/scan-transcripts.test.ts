import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscripts } from "./scan-transcripts.js";

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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
