/**
 * kit-research wfx-github-actions-campaign-vs-kit: a `postinstall` added to the repository's own
 * package.json, running a hidden `.ci-xxxxxx.sh`, produced no row in `kit check`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkOwnLifecycleHook,
  hiddenScriptFiles,
  ownLifecycleHiddenFiles,
} from "./check-own-lifecycle-hook.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "p", scripts });

describe("hiddenScriptFiles", () => {
  it("finds a file whose own name starts with a dot", () => {
    assert.deepEqual(hiddenScriptFiles("sh .ci-ab12cd.sh"), [".ci-ab12cd.sh"]);
    assert.deepEqual(hiddenScriptFiles('node "./.setup.mjs" && echo ok'), ["./.setup.mjs"]);
    assert.deepEqual(hiddenScriptFiles("bash scripts/.run.sh;true"), ["scripts/.run.sh"]);
  });

  it("leaves ordinary files, dot directories and bare commands alone", () => {
    assert.deepEqual(hiddenScriptFiles("node .husky/install.mjs"), []);
    assert.deepEqual(hiddenScriptFiles("node scripts/postinstall.js"), []);
    assert.deepEqual(hiddenScriptFiles("husky && cd .. && tsc -p ."), []);
    assert.deepEqual(hiddenScriptFiles("cp .env.example .env"), []);
  });
});

describe("ownLifecycleHiddenFiles", () => {
  it("reads the four scripts npm install runs, and no other", () => {
    const found = ownLifecycleHiddenFiles(
      pkg({ postinstall: "sh .a.sh", prepare: "node .b.mjs", test: "sh .c.sh", build: "sh .d.sh" }),
    );
    assert.deepEqual(found, [
      ["postinstall", ".a.sh"],
      ["prepare", ".b.mjs"],
    ]);
  });

  it("returns nothing for a package.json that does not parse or has no scripts", () => {
    assert.deepEqual(ownLifecycleHiddenFiles("{"), []);
    assert.deepEqual(ownLifecycleHiddenFiles('{"name":"p"}'), []);
  });
});

describe("checkOwnLifecycleHook", () => {
  const project = (t: { after(fn: () => void): void }, body?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-own-hook-"));
    t.after(() => rmTemp(dir));
    if (body !== undefined) writeFileSync(join(dir, "package.json"), body);
    return dir;
  };

  it("warns on the wfx shape and names the script and the file", (t) => {
    const rows = checkOwnLifecycleHook(project(t, pkg({ postinstall: "sh .ci-ab12cd.sh" })));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "warn");
    assert.equal(rows[0]?.name, "package.json postinstall runs a hidden file (.ci-ab12cd.sh)");
  });

  it("says nothing for an ordinary postinstall, or without a package.json", (t) => {
    assert.deepEqual(checkOwnLifecycleHook(project(t, pkg({ postinstall: "husky" }))), []);
    assert.deepEqual(checkOwnLifecycleHook(project(t)), []);
  });

  it("is part of kit check --category security (real CLI)", (t) => {
    const dir = project(t, pkg({ postinstall: "sh .ci-ab12cd.sh" }));
    writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const r = spawnSync(process.execPath, [cli, "check", "--category", "security"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      timeout: 120_000,
    });
    assert.match(r.stdout + r.stderr, /package\.json postinstall runs a hidden file/);
  });
});
