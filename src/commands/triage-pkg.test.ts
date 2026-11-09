import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTriagePkg } from "./triage-pkg.js";

// A file named like a package. The macOS tools reject it (it is not a package), so the
// signature and notarization checks never pass here, and the checksum check is the one under test.
let dir: string;
let file: string;
let sha: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-triage-pkg-"));
  file = join(dir, "tool.pkg");
  writeFileSync(file, "not a package");
  sha = createHash("sha256").update("not a package").digest("hex");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  console.error = (...a: unknown[]) => void (err += `${a.join(" ")}\n`);
  try {
    return { ok: await cmdTriagePkg(args), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("kit triage pkg", () => {
  it("asks for a file, and refuses one that is not a file", async () => {
    const none = await run([]);
    assert.equal(none.ok, false);
    assert.match(none.err, /usage: kit triage pkg/);
    assert.equal((await run([dir])).ok, false);
    assert.equal((await run([join(dir, "missing.pkg")])).ok, false);
  });

  it("refuses a malformed --team-id or --checksum", async () => {
    assert.match((await run([file, "--team-id", "abc"])).err, /ten capitals or digits/);
    assert.match((await run([file, "--checksum", "zz"])).err, /64 hex digits or a readable/);
  });

  it("takes the file from the first argument that is not a flag value", async () => {
    const r = await run(["--checksum", sha, "--team-id", "HX7739G8FX", "--json", file]);
    const report = JSON.parse(r.out);
    assert.equal(report.file, file);
    assert.equal(report.checks[0].status, "pass");
  });

  it("never passes a file the macOS tools do not accept, even with a matching checksum", async () => {
    const r = await run([file, "--checksum", sha, "--team-id", "HX7739G8FX", "--json"]);
    assert.equal(r.ok, false);
    assert.equal(JSON.parse(r.out).passed, false);
  });

  it("reads the checksum from a list file, and fails on a different file", async () => {
    const list = join(dir, "SHASUMS256.txt");
    writeFileSync(list, `${sha}  tool.pkg\n`);
    assert.equal(
      JSON.parse((await run([file, "--checksum", list, "--json"])).out).checks[0].status,
      "pass",
    );
    writeFileSync(list, `${"0".repeat(64)}  tool.pkg\n`);
    assert.equal(
      JSON.parse((await run([file, "--checksum", list, "--json"])).out).checks[0].status,
      "fail",
    );
  });

  it("prints a readable report", async () => {
    const r = await run([file, "--checksum", sha]);
    assert.match(r.out, /kit triage pkg/);
    assert.match(r.out, /checksum: matches --checksum/);
    assert.match(r.out, /not passed/);
  });
});
