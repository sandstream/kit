/** `instruction-file secrets`: a key in a file any harness loads as instructions fails `kit check`. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkAgentConfig } from "./check-agent-config.js";
import { checkInstructionSecrets } from "./check-instruction-secrets.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Built at run time so this file holds no literal key shape.
const KEY = ["sk", "proj", "A".repeat(40) + "0000"].join("-");
const LINE = `Use OPENAI_API_KEY=${KEY} for the demo.\n`;

/** One file per harness, as the measurement in kit-research ai-built-app-holes-vs-kit placed them. */
const HARNESS_FILES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".cursorrules",
  ".cursor/rules/a.mdc",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".claude/rules/nested/r.md",
  ".claude/commands/c.md",
  ".claude/agents/a.md",
];

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-instruction-secrets-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("checkInstructionSecrets: every harness's instruction files", () => {
  for (const file of HARNESS_FILES) {
    it(`fails on a key in ${file}, naming the file and pattern, never the value`, () => {
      const dir = tree({ [file]: LINE });
      try {
        const [row] = checkInstructionSecrets(dir);
        assert.equal(row.name, "instruction-file secrets");
        assert.equal(row.status, "fail");
        assert.equal(row.severity, "critical");
        assert.ok(row.detail.includes(file), row.detail);
        assert.match(row.detail, /ai-api-key/);
        assert.ok(!row.detail.includes(KEY.slice(0, 12)), "value prefix must not be printed");
        assert.ok(!row.detail.includes("0000"), "value tail must not be printed");
      } finally {
        rmTemp(dir);
      }
    });
  }

  it("reads lower-case agents.md, the name Lovable and others write", () => {
    const dir = tree({ "agents.md": LINE });
    try {
      assert.equal(checkInstructionSecrets(dir)[0].status, "fail");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkInstructionSecrets: clean, absent and other files", () => {
  it("passes clean instruction files and names the harnesses it covers", () => {
    const dir = tree({ "AGENTS.md": "Run npm test. Keys live in `kit secrets`.\n" });
    try {
      const [row] = checkInstructionSecrets(dir);
      assert.equal(row.status, "pass");
      assert.match(row.detail, /1 instruction file\b/);
      assert.match(row.detail, /Codex, Cursor, Gemini CLI, Copilot/);
    } finally {
      rmTemp(dir);
    }
  });

  it("skips a project with no instruction file, and does not read other markdown", () => {
    const dir = tree({ "README.md": LINE, "docs/setup.md": LINE });
    try {
      const [row] = checkInstructionSecrets(dir);
      assert.equal(row.status, "skip");
    } finally {
      rmTemp(dir);
    }
  });

  it("is part of kit check's agent configuration rows", async () => {
    const dir = tree({ "AGENTS.md": LINE });
    const home = mkdtempSync(join(tmpdir(), "kit-instruction-secrets-home-"));
    try {
      const rows = await checkAgentConfig(dir, home, {});
      const row = rows.find((r) => r.name === "instruction-file secrets");
      assert.equal(row?.status, "fail");
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });
});
