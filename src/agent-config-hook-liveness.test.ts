import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WRAPPER_MARKER } from "./kit-wrapper.js";
import {
  commandIncludesSubcommand,
  expandHomePath,
  hookCommandProblems,
} from "./agent-config-hook-liveness.js";

const q = (s: string) => `"${s}"`;

describe("commandIncludesSubcommand", () => {
  it("finds the subcommand as its own argument, including after a quoted path with spaces", () => {
    assert.equal(
      commandIncludesSubcommand(`${q("/opt/my tools/kit")} gate-bash`, "gate-bash"),
      true,
    );
    assert.equal(commandIncludesSubcommand("/usr/bin/kit gate-bash-extra", "gate-bash"), false);
    assert.equal(commandIncludesSubcommand("/usr/bin/kit gate-fs", "gate-bash"), false);
  });
});

describe("expandHomePath", () => {
  it("expands every home spelling a hook command uses, and nothing else", () => {
    for (const form of ["~", "$HOME", "${HOME}"]) assert.equal(expandHomePath(form), homedir());
    for (const form of ["~/x", "$HOME/x", "${HOME}/x"]) {
      assert.equal(expandHomePath(form), join(homedir(), "x"));
    }
    assert.equal(expandHomePath("/abs/~/x"), "/abs/~/x");
    assert.equal(expandHomePath("~user/x"), "~user/x");
  });
});

describe("hookCommandProblems", () => {
  it("rejects bare `kit` and non-absolute executables, which non-login shells cannot resolve", () => {
    assert.match(hookCommandProblems("kit gate-bash").join(), /bare `kit`/);
    assert.match(hookCommandProblems("exec kit gate-bash").join(), /bare `kit`/);
    assert.match(hookCommandProblems("node dist/cli.js gate-bash").join(), /non-absolute/);
    assert.match(hookCommandProblems("").join(), /empty hook command/);
  });

  it("reports a missing target, and a node command whose kit CLI is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-hook-liveness-"));
    try {
      assert.match(hookCommandProblems(q(join(dir, "nope"))).join(), /missing or not executable/);
      const cmd = `${q(process.execPath)} ${q(join(dir, "missing-cli.js"))} gate-bash`;
      assert.match(hookCommandProblems(cmd).join(), /kit CLI missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an absolute node plus an existing kit CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-hook-liveness-"));
    try {
      const cli = join(dir, "cli.js");
      writeFileSync(cli, "");
      assert.deepEqual(hookCommandProblems(`${q(process.execPath)} ${q(cli)} gate-bash`), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a /root path only when /root is not this machine's home", () => {
    const problems = hookCommandProblems("/root/.kit/bin/kit gate-bash").join();
    if (homedir() === "/root") assert.doesNotMatch(problems, /root\/container path/);
    else assert.match(problems, /root\/container path/);
  });

  it("reports a malformed kit-managed wrapper", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-hook-liveness-"));
    try {
      const wrapper = join(dir, "kit");
      writeFileSync(wrapper, `#!/bin/sh\n${WRAPPER_MARKER}\necho broken\n`, { mode: 0o755 });
      assert.match(hookCommandProblems(`${q(wrapper)} gate-bash`).join(), /wrapper is malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
