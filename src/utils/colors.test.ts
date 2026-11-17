import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorEnabled } from "./colors.js";

describe("colorEnabled (https://no-color.org)", () => {
  it("is off when NO_COLOR is set to a non-empty value, even on a terminal or with FORCE_COLOR", () => {
    assert.equal(colorEnabled({ NO_COLOR: "1" }, true), false);
    assert.equal(colorEnabled({ NO_COLOR: "true" }, true), false);
    assert.equal(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true), false);
  });
  it("is on for a terminal when NO_COLOR is unset or empty", () => {
    assert.equal(colorEnabled({}, true), true);
    assert.equal(colorEnabled({ NO_COLOR: "" }, true), true);
  });
  it("is off when stdout is not a terminal (a pipe, a file, a CI log)", () => {
    assert.equal(colorEnabled({}, false), false);
    assert.equal(colorEnabled({ NO_COLOR: "" }, false), false);
  });
  it("FORCE_COLOR turns it on without a terminal, and 0 or false turns it off on one", () => {
    for (const v of ["1", "2", "3", "true", ""])
      assert.equal(colorEnabled({ FORCE_COLOR: v }, false), true, v);
    for (const v of ["0", "false", "FALSE"])
      assert.equal(colorEnabled({ FORCE_COLOR: v }, true), false, v);
  });
});

describe("the CLI's colour on a pipe", () => {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  // spawnSync's stdout is a pipe, as in `kit … | cat`. FORCE_COLOR is cleared first: Node's test
  // runner may set it for its children when the runner itself writes to a terminal.
  const run = (env: NodeJS.ProcessEnv) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-no-color-"));
    try {
      const base: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "" };
      delete base.FORCE_COLOR;
      return spawnSync(process.execPath, [cli, "gha-audit"], {
        cwd: dir,
        env: { ...base, ...env },
        encoding: "utf8",
      }).stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("prints no escape sequence on a pipe, or with NO_COLOR=1", () => {
    for (const plain of [run({}), run({ NO_COLOR: "1" })]) {
      assert.match(plain, /gha-audit/);
      assert.doesNotMatch(plain, /\x1b\[/);
    }
  });

  it("colours a pipe when FORCE_COLOR=1, unless NO_COLOR is set", () => {
    assert.match(run({ FORCE_COLOR: "1" }), /\x1b\[/);
    assert.doesNotMatch(run({ FORCE_COLOR: "1", NO_COLOR: "1" }), /\x1b\[/);
  });
});
