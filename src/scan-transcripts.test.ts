import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscripts } from "./scan-transcripts.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-scan-tx-"));
}

describe("scanTranscripts", () => {
  it("reports missing evidence when no agent dirs exist", async () => {
    const dir = makeRepo();
    try {
      const { hits, evidenceStatus } = await scanTranscripts(dir);
      assert.equal(evidenceStatus, "missing");
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
      const { hits, evidenceStatus, filesScanned } = await scanTranscripts(dir);
      assert.equal(evidenceStatus, "complete-empty");
      assert.equal(filesScanned, 1);
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
      const { hits } = await scanTranscripts(dir);
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
      const { hits } = await scanTranscripts(dir);
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
      const { hits } = await scanTranscripts(dir);
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
      const scan = await scanTranscripts(dir);
      assert.equal(scan.evidenceStatus, "complete-empty");
      assert.deepEqual(scan.hits, []);
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
      const { hits } = await scanTranscripts(dir);
      assert.deepEqual(
        hits.map((h) => h.file),
        [join(dir, ".claude", "session.jsonl")],
      );
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanTranscripts preserves incomplete coverage", () => {
  it(
    "reports selected links without reading their targets",
    { skip: process.platform === "win32" },
    async () => {
      const dir = makeRepo();
      try {
        const agent = join(dir, ".codex");
        const target = join(dir, "outside.jsonl");
        mkdirSync(agent);
        writeFileSync(target, '{"text":"AKIA0123456789ABCDEF"}\n');
        symlinkSync(target, join(agent, "session.jsonl"));
        const scan = await scanTranscripts(dir);
        assert.equal(scan.evidenceStatus, "partial");
        assert.deepEqual(scan.gaps, { unsupported: 1 });
        assert.equal(scan.filesScanned, 0);
        assert.deepEqual(scan.hits, []);
      } finally {
        rmTemp(dir);
      }
    },
  );

  it("reports an oversized file and still finds a credential in a readable file", async () => {
    const dir = makeRepo();
    try {
      const agent = join(dir, ".claude");
      mkdirSync(agent);
      const large = join(agent, "large.jsonl");
      writeFileSync(large, "");
      truncateSync(large, 10 * 1024 * 1024 + 1);
      const short = join(agent, "short.jsonl");
      writeFileSync(short, '{"text":"AKIA0123456789ABCDEF"}\n');
      const scan = await scanTranscripts(dir);
      assert.equal(scan.evidenceStatus, "partial");
      assert.deepEqual(scan.gaps, { oversized: 1 });
      assert.equal(scan.filesScanned, 1);
      assert.equal(scan.hits[0]?.file, short);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanTranscripts reports limits on directory and file reads", () => {
  it("reports an unvisited directory at the depth limit", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".codex", "a", "b", "c", "d", "e", "f", "g"), { recursive: true });
      const scan = await scanTranscripts(dir);
      assert.equal(scan.evidenceStatus, "partial");
      assert.deepEqual(scan.gaps, { "depth limit": 1 });
      assert.equal(scan.filesScanned, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("keeps a finding in a malformed UTF-8 file while reporting the gap", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, ".codex"));
      const bad = join(dir, ".codex", "session.jsonl");
      writeFileSync(
        bad,
        Buffer.concat([Buffer.from([0xff, 0x20]), Buffer.from("AKIA0123456789ABCDEF")]),
      );
      const scan = await scanTranscripts(dir);
      assert.equal(scan.evidenceStatus, "partial");
      assert.deepEqual(scan.gaps, { malformed: 1 });
      assert.equal(scan.hits[0]?.file, bad);
    } finally {
      rmTemp(dir);
    }
  });

  it(
    "reports unreadable files and directories",
    {
      skip: process.platform === "win32" || process.getuid?.() === 0,
    },
    async () => {
      const dir = makeRepo();
      const child = join(dir, ".codex", "child");
      const log = join(dir, ".codex", "session.jsonl");
      mkdirSync(child, { recursive: true });
      writeFileSync(log, "{}\n");
      try {
        chmodSync(child, 0);
        chmodSync(log, 0);
        const scan = await scanTranscripts(dir);
        assert.equal(scan.evidenceStatus, "partial");
        assert.deepEqual(scan.gaps, { unreadable: 2 });
        assert.equal(scan.filesScanned, 0);
      } finally {
        chmodSync(child, 0o700);
        chmodSync(log, 0o600);
        rmTemp(dir);
      }
    },
  );
});
