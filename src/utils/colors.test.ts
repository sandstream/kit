import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorEnabled } from "./colors.js";

describe("colorEnabled (https://no-color.org)", () => {
  it("is off when NO_COLOR is set to a non-empty value", () => {
    assert.equal(colorEnabled({ NO_COLOR: "1" }), false);
    assert.equal(colorEnabled({ NO_COLOR: "true" }), false);
  });
  it("is on when NO_COLOR is unset or empty", () => {
    assert.equal(colorEnabled({}), true);
    assert.equal(colorEnabled({ NO_COLOR: "" }), true);
  });
});

describe("the CLI honors NO_COLOR", () => {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const run = (env: NodeJS.ProcessEnv) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-no-color-"));
    try {
      return spawnSync(process.execPath, [cli, "gha-audit"], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: "", ...env },
        encoding: "utf8",
      }).stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("prints no escape sequence with NO_COLOR=1, and colors without it", () => {
    const plain = run({ NO_COLOR: "1" });
    assert.match(plain, /gha-audit/);
    assert.doesNotMatch(plain, /\x1b\[/);
    assert.match(run({}), /\x1b\[/);
  });
});
