import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "../temp-cleanup.test-support.js";

const source = import.meta.url.endsWith(".ts");
const tsx = source ? ["--import", import.meta.resolve("tsx")] : [];

describe("kit memory hook user-prompt-submit and the payload source", () => {
  let tmp: string;
  const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "kit-hook-source-")));
  });
  after(() => rmTemp(tmp));

  function hook(payload: object): { status: number | null; stdout: string } {
    const r = spawnSync(process.execPath, [...tsx, cli, "memory", "hook", "user-prompt-submit"], {
      cwd: tmp,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        KIT_MEMORY_DB: join(tmp, "memory.db"),
        KIT_MEMORY_DIR: join(tmp, "kit"),
        KIT_CLAUDE_DIR: join(tmp, "claude"),
        KIT_CODEX_DIR: join(tmp, "codex"),
        KIT_NO_UPDATE_CHECK: "1",
      },
    });
    return { status: r.status, stdout: r.stdout };
  }

  it("injects the memory reminder for a user prompt and nothing for a poll event", () => {
    const user = hook({ source: "user", session_id: "s1", prompt: "hi" });
    assert.equal(user.status, 0);
    assert.match(user.stdout, /kit memory search/);
    const poll = hook({ source: "poll_event", session_id: "s1", prompt: "background output" });
    assert.equal(poll.status, 0);
    assert.equal(poll.stdout, "");
  });
});
