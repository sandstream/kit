import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTemp } from "../temp-cleanup.test-support.js";

const adjacentCli = resolve(import.meta.dirname, "../cli.js");
const CLI = existsSync(adjacentCli)
  ? adjacentCli
  : resolve(import.meta.dirname, "../../dist/cli.js");

describe("kit statusline", () => {
  it("`kit statusline --json` prints one parseable object matching the text form", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-statusline-json-"));
    try {
      const run = (args: string[]) =>
        execFileSync(process.execPath, [CLI, "statusline", ...args], {
          cwd: dir,
          env: { ...process.env, HOME: dir, USERPROFILE: dir, NODE_NO_WARNINGS: "1" },
          encoding: "utf8",
        });
      const data = JSON.parse(run(["--json"])) as Record<string, unknown>;
      assert.equal(data.text, run([]).trim());
      assert.equal(data.mode, "full");
      assert.equal(data.next, "kit init");
      assert.ok(Array.isArray(data.gaps) && data.gaps.length > 0);
      assert.equal(data.pal, 0);
    } finally {
      rmTemp(dir);
    }
  });
});
