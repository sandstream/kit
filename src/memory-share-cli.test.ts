import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

describe("kit memory share CLI", () => {
  it("writes explicit operator provenance by default (#550)", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-share-cli-"));
    try {
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "memory",
          "share",
          "--area",
          "memory",
          "--kind",
          "decision",
          "--title",
          "default provenance",
          "--body",
          "operator promoted this",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            KIT_IDENTITY_DIR: join(root, "identity"),
            KIT_MEMORY_DB: join(root, "memory.db"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const raw = readFileSync(join(root, ".kit", "shared", "memory.jsonl"), "utf8").trim();
      const entry = JSON.parse(raw) as { provenance?: string };
      assert.equal(entry.provenance, "operator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors explicit derived provenance (#550)", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-share-cli-"));
    try {
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "memory",
          "share",
          "--area",
          "memory",
          "--kind",
          "decision",
          "--title",
          "derived provenance",
          "--body",
          "kit derived this",
          "--provenance",
          "derived",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            KIT_IDENTITY_DIR: join(root, "identity"),
            KIT_MEMORY_DB: join(root, "memory.db"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const raw = readFileSync(join(root, ".kit", "shared", "memory.jsonl"), "utf8").trim();
      const entry = JSON.parse(raw) as { provenance?: string };
      assert.equal(entry.provenance, "derived");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
