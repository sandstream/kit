import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRecommendedHardening } from "./recommended.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const KEYS = [
  "HOME",
  "KIT_CLAUDE_SETTINGS",
  "KIT_CODEX_HOOKS",
  "KIT_MEMORY_HOOK_MARKER",
  "KIT_CODEX_MEMORY_HOOK_MARKER",
] as const;

describe(
  "applyRecommendedHardening: hooks call the managed wrapper",
  { skip: process.platform === "win32" },
  () => {
    let tmp: string;
    const saved: Record<string, string | undefined> = {};

    before(() => {
      tmp = mkdtempSync(join(tmpdir(), "kit-recwrap-"));
      for (const k of KEYS) saved[k] = process.env[k];
      mkdirSync(join(tmp, "home"));
      process.env.HOME = join(tmp, "home");
      process.env.KIT_CLAUDE_SETTINGS = join(tmp, "claude.json");
      process.env.KIT_CODEX_HOOKS = join(tmp, "codex.json");
      process.env.KIT_MEMORY_HOOK_MARKER = join(tmp, "claude-marker");
      process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(tmp, "codex-marker");
    });
    after(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmTemp(tmp);
    });

    it("points the generated hooks at the wrapper and bakes in no Node path", async () => {
      const g = join(mkdtempSync(join(tmp, "git-")), ".git");
      await applyRecommendedHardening({ context: { git: { email: "x@y.z" } } }, g);
      const wrapper = join(tmp, "home", ".kit", "bin", "kit");
      assert.ok(existsSync(wrapper), "the wrapper is written so the hooks have something to call");
      for (const name of ["pre-commit", "pre-push"]) {
        const text = readFileSync(join(g, "hooks", name), "utf-8");
        assert.ok(text.includes(`${wrapper} `), `${name} calls the wrapper`);
        assert.equal(text.includes(process.execPath), false, `${name} bakes in no Node path`);
      }
    });
  },
);
