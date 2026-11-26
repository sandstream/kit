import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTriageRelease } from "./triage-release-asset.js";
import type { ReleaseDeps } from "../release-triage.js";
import { makeTarGz } from "../release-fixtures.test-support.js";

const URL_ = "https://h.example/releases/v1/tool.tar.gz";
const BYTES = makeTarGz([{ name: "tool", mode: 0o755, data: "\x7fELF" }]);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const ACCEPT = ["--accept-unverified", "signature,age,repository"];

let dir: string;
let cwd: string;
let realFetch: typeof fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-triage-release-"));
  cwd = process.cwd();
  process.chdir(dir);
  realFetch = globalThis.fetch;
  writeFileSync(join(dir, "tool.tar.gz"), BYTES);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const offline: ReleaseDeps = {
  githubApi: null,
  fetchText: async () => null,
  getJson: async () => null,
  age: async () => ({ status: "unverified", detail: "not asked" }),
};

async function run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const [log, error] = [console.log, console.error];
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  console.error = (...a: unknown[]) => void (err += `${a.join(" ")}\n`);
  try {
    return { ok: await cmdTriageRelease(args, offline), out, err };
  } finally {
    [console.log, console.error] = [log, error];
  }
}

const receipts = (): { type: string; target: string; contentDigest?: string }[] =>
  existsSync(join(dir, ".kit-triage.jsonl"))
    ? readFileSync(join(dir, ".kit-triage.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

describe("kit triage release (command)", () => {
  it("refuses a missing target and malformed flags", async () => {
    assert.match((await run([])).err, /usage: kit triage release/);
    assert.match((await run(["tool.tar.gz", "--checksum", "zz"])).err, /64 hex digits/);
    assert.match(
      (await run(["tool.tar.gz", "--accept-unverified", "everything"])).err,
      /takes checksum/,
    );
    assert.match((await run(["tool.tar.gz", "--repo", "nope"])).err, /owner\/repo/);
    assert.match((await run(["tool.tar.gz", "--url", "ftp://x"])).err, /http\(s\) URL/);
  });

  it("records a receipt for --url only when every check passed or was accepted by name", async () => {
    const held = await run(["tool.tar.gz", "--url", URL_, "--checksum", SHA]);
    assert.equal(held.ok, false);
    assert.deepEqual(receipts(), []);
    const r = await run(["tool.tar.gz", "--url", URL_, "--checksum", SHA, ...ACCEPT, "--json"]);
    assert.equal(r.ok, true, r.out + r.err);
    assert.equal(JSON.parse(r.out).recorded, URL_);
    assert.deepEqual(
      receipts().map((e) => [e.type, e.target, e.contentDigest]),
      [["release", URL_, `sha256:${SHA}`]],
    );
  });

  it("writes no receipt for a local file with no URL, and says why", async () => {
    const r = await run(["tool.tar.gz", "--checksum", SHA, ...ACCEPT]);
    assert.equal(r.ok, true);
    assert.match(r.out, /No receipt: give --url/);
    assert.deepEqual(receipts(), []);
  });

  it("downloads a URL into a private temporary directory, checks it, and removes it", async () => {
    let asked = "";
    globalThis.fetch = (async (u: string | URL) => {
      asked = String(u);
      return new Response(new Uint8Array(BYTES), { status: 200 });
    }) as typeof fetch;
    const r = await run([
      "HTTPS://H.EXAMPLE/releases/v1/tool.tar.gz#x",
      "--checksum",
      SHA,
      ...ACCEPT,
      "--json",
    ]);
    assert.equal(r.ok, true, r.err);
    assert.equal(asked, URL_, "the URL is fetched and recorded in its canonical spelling");
    const report = JSON.parse(r.out);
    assert.equal(existsSync(report.file), false, "the download is removed afterwards");
    assert.equal(receipts()[0]!.target, URL_);
  });

  it("refuses a download that fails, without a receipt", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
    const r = await run([URL_, "--checksum", SHA, ...ACCEPT]);
    assert.equal(r.ok, false);
    assert.match(r.err, /cannot download .*HTTP 404/);
    assert.deepEqual(receipts(), []);
  });
});
