import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promptFromUser } from "./hook-payload.js";

const source = import.meta.url.endsWith(".ts");
const MODULE = fileURLToPath(
  new URL(source ? "./hook-payload.ts" : "./hook-payload.js", import.meta.url),
);
const tsx = source ? ["--import", import.meta.resolve("tsx")] : [];

/** Run `readHookPayload` in a child with `input` on stdin; print what it parsed. */
function readIn(input: string, args = "300"): string {
  const script = `
    const { readHookPayload } = await import(${JSON.stringify(MODULE)});
    const first = await readHookPayload(${args});
    const second = await readHookPayload(${args});
    process.stdout.write(JSON.stringify({ first, same: first === second }));
  `;
  const r = spawnSync(process.execPath, [...tsx, "--input-type=module", "-e", script], {
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe("promptFromUser", () => {
  it("is false for a payload from a source other than the user", () => {
    assert.equal(promptFromUser({ source: "poll_event" }), false);
    assert.equal(promptFromUser({ source: "user" }), true);
  });

  it("treats a payload without a string source as the user's (older harnesses, Codex, no stdin)", () => {
    assert.equal(promptFromUser(undefined), true);
    assert.equal(promptFromUser({ prompt: "hi" }), true);
    assert.equal(promptFromUser({ source: 7 }), true);
  });
});

describe("readHookPayload", () => {
  it("parses a JSON object once and shares it between callers", () => {
    const out = JSON.parse(readIn(JSON.stringify({ source: "user", session_id: "s1" })));
    assert.deepEqual(out, { first: { source: "user", session_id: "s1" }, same: true });
  });

  it("returns undefined for empty, non-JSON, non-object and oversized input", () => {
    assert.equal(readIn(""), JSON.stringify({ same: true }));
    assert.equal(readIn("not json"), JSON.stringify({ same: true }));
    assert.equal(readIn("[1,2]"), JSON.stringify({ same: true }));
    const big = JSON.stringify({ source: "user", prompt: "x".repeat(4096) });
    assert.equal(readIn(big, "300, 1024"), JSON.stringify({ same: true }));
  });

  it("does not wait past its timeout when stdin is never closed", async () => {
    const script = `
      const { readHookPayload } = await import(${JSON.stringify(MODULE)});
      process.stdout.write(String(await readHookPayload(200)));
    `;
    const started = Date.now();
    const child = spawn(process.execPath, [...tsx, "--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    assert.equal(code, 0);
    assert.equal(out, "undefined");
    assert.ok(Date.now() - started < 8_000);
  });
});
