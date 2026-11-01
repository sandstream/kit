/**
 * The services hook surface: what the owning session hears on a prompt, what a new session hears
 * at start, and what SessionEnd records. Also the stdin session-id read, through a real child
 * process, because a hook that waits forever on stdin hangs the user's prompt.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { mutateRegistry, readRegistry, type ServiceEntry } from "./registry.js";
import { servicesPromptNotice, servicesSessionEnd, servicesSessionStart } from "./hook.js";

const HOOK_MODULE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "hook.js")).href;
const NOW = Date.parse("2026-11-01T10:00:00Z");

let dir: string;
let file: string;

function add(partial: Partial<ServiceEntry> & { name: string }): void {
  mutateRegistry((reg) => {
    reg.services.push({
      kind: "container",
      ref: partial.name,
      project: "/repo",
      owner: { agent: "claude", session: "S1" },
      startedAt: new Date(NOW).toISOString(),
      leaseUntil: new Date(NOW + 4 * 3_600_000).toISOString(),
      ...partial,
    });
    return { result: undefined };
  }, file);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-services-hook-"));
  file = join(dir, "services.json");
});
afterEach(() => rmTemp(dir));

describe("servicesPromptNotice", () => {
  it("is silent with no session, no registry, or nothing to report", () => {
    assert.equal(servicesPromptNotice(undefined, NOW, file), "");
    assert.equal(servicesPromptNotice("S1", NOW, file), "");
    add({ name: "quiet" });
    assert.equal(servicesPromptNotice("S1", NOW, file), "");
  });

  it("tells the owner about a stop request, in one line, with both answers", () => {
    add({
      name: "db",
      stopRequest: {
        by: { agent: "codex", session: "C9999999" },
        at: new Date(NOW).toISOString(),
        message: "swap is full",
      },
    });
    const line = servicesPromptNotice("S1", NOW, file);
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /codex:C9999999 asks to stop "db"/);
    assert.match(line, /swap is full/);
    assert.match(line, /kit services keep db/);
    assert.match(line, /kit services release db/);
    // Another session hears nothing about it.
    assert.equal(servicesPromptNotice("S2", NOW, file), "");
  });

  it("warns when a lease ends within 30 minutes, and when it has ended", () => {
    add({ name: "soon", leaseUntil: new Date(NOW + 20 * 60_000).toISOString() });
    add({ name: "later", leaseUntil: new Date(NOW + 31 * 60_000).toISOString() });
    add({ name: "past", leaseUntil: new Date(NOW - 60_000).toISOString() });
    const line = servicesPromptNotice("S1", NOW, file);
    assert.match(line, /"soon" ends in 20 min/);
    assert.match(line, /"past" has ended/);
    assert.doesNotMatch(line, /later/);
  });

  it("fails open on a corrupt registry", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{nope");
    assert.equal(servicesPromptNotice("S1", NOW, file), "");
    assert.deepEqual(servicesSessionStart("S1", "/repo", NOW, file), []);
    assert.deepEqual(servicesSessionEnd("S1", NOW, file), []);
  });
});

describe("servicesSessionEnd / servicesSessionStart", () => {
  it("marks the ended session's entries, and the next session in the project hears about them", () => {
    add({ name: "db" });
    add({ name: "other-session", owner: { agent: "claude", session: "S2" } });
    add({ name: "elsewhere", project: "/other" });
    assert.deepEqual(servicesSessionEnd("S1", NOW, file), ["db", "elsewhere"]);
    const reg = readRegistry(file);
    assert.ok(reg.services.find((e) => e.name === "db")!.ownerEndedAt);
    assert.equal(reg.services.find((e) => e.name === "other-session")!.ownerEndedAt, undefined);

    const lines = servicesSessionStart("S3", "/repo", NOW, file);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]!,
      /1 service\(s\) for this project belong to sessions that have ended: db/,
    );
    assert.match(lines[0]!, /kit services ls/);
  });

  it("a resumed session takes its entries back", () => {
    add({ name: "db" });
    servicesSessionEnd("S1", NOW, file);
    assert.deepEqual(servicesSessionStart("S1", "/repo", NOW, file), []);
    assert.equal(readRegistry(file).services[0]!.ownerEndedAt, undefined);
  });

  it("does not write the file when the session owns nothing", () => {
    add({ name: "db", owner: { agent: "claude", session: "S2" } });
    const before = readRegistry(file);
    assert.deepEqual(servicesSessionEnd("S1", NOW, file), []);
    assert.deepEqual(readRegistry(file), before);
  });
});

describe("hookSessionId", () => {
  function run(input: string | null, env: Record<string, string> = {}): string {
    const script = `
      const { hookSessionId } = await import(${JSON.stringify(HOOK_MODULE)});
      process.stdout.write(String(await hookSessionId(process.env, 300)));
    `;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.CLAUDE_CODE_SESSION_ID;
    delete childEnv.CODEX_THREAD_ID;
    delete childEnv.CODEX_SESSION_ID;
    Object.assign(childEnv, env);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: input ?? undefined,
      stdio: [input === null ? "pipe" : "pipe", "pipe", "inherit"],
      env: childEnv,
      timeout: 10_000,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    return r.stdout;
  }

  it("reads session_id from the hook payload on stdin", () => {
    assert.equal(
      run(JSON.stringify({ session_id: "from-stdin", hook_event_name: "X" })),
      "from-stdin",
    );
  });

  it("falls back to the environment when stdin has no payload", () => {
    assert.equal(run("", { CLAUDE_CODE_SESSION_ID: "from-env" }), "from-env");
    assert.equal(run("not json", { CODEX_THREAD_ID: "codex-env" }), "codex-env");
    assert.equal(run(""), "undefined");
  });

  it("does not hang when the harness never closes stdin", async () => {
    const { spawn } = await import("node:child_process");
    const script = `
      const { hookSessionId } = await import(${JSON.stringify(HOOK_MODULE)});
      process.stdout.write(String(await hookSessionId({ CLAUDE_CODE_SESSION_ID: "env-id" }, 300)));
    `;
    const started = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    assert.equal(code, 0);
    assert.equal(out, "env-id");
    assert.ok(Date.now() - started < 5_000, "returned after its own timeout");
  });
});
