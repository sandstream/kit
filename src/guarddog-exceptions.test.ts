import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GUARDDOG_EXCEPTIONS_FILE,
  guardDogWaiver,
  parseGuardDogExceptions,
} from "./guarddog-exceptions.js";
import { classifyGuardDog, guardDogScope } from "./guarddog.js";

const NOW = new Date("2026-11-28T12:00:00Z");
const SOURCE = "const token = process.env.EXAMPLE_TOKEN;\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const MANIFEST = '{"name":"@scope/fixture","version":"1.0.0"}';

const entry = (over: Record<string, unknown> = {}) => ({
  package: "@scope/fixture",
  version: "1.0.0",
  rule: "threat-runtime-environment-read",
  file: "dist/examples/a.js",
  sha256: sha(SOURCE),
  reason: "example code reads its own configuration variable",
  expires: "2027-02-25",
  ...over,
});

function report(
  rule = "threat-runtime-environment-read",
  location = "package/dist/examples/a.js:1",
  errors: Record<string, string> = {},
) {
  const hit = { location, code: SOURCE, message: "Detects reading of environment variables" };
  const result = { issues: 1, errors, results: { [rule]: [hit] } };
  const stdout = JSON.stringify([{ dependency: "@scope/fixture", version: "1.0.0", result }]);
  return { exitCode: 0, ok: true, stdout, stderr: "" };
}

const scope = () => guardDogScope("npm", '{"devDependencies":{"@scope/fixture":"1.0.0"}}');

async function withRepo(entries: unknown, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "kit-guarddog-exceptions-"));
  try {
    const dir = join(root, "node_modules", "@scope", "fixture");
    mkdirSync(join(dir, "dist", "examples"), { recursive: true });
    writeFileSync(join(dir, "package.json"), MANIFEST);
    writeFileSync(join(dir, "dist", "examples", "a.js"), SOURCE);
    if (entries !== undefined) {
      writeFileSync(join(root, GUARDDOG_EXCEPTIONS_FILE), JSON.stringify(entries));
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function classify(root: string, rule?: string, location?: string, now = NOW) {
  return classifyGuardDog(report(rule, location), scope(), false, await guardDogWaiver(root, now));
}

describe("parseGuardDogExceptions", () => {
  it("accepts an exact entry", () => {
    const r = parseGuardDogExceptions([entry()], NOW);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.exceptions, [entry()]);
  });

  it("refuses wide, unhashed, unexplained or permanent entries", () => {
    const bad = [
      entry({ file: "dist/*.js" }),
      entry({ file: "../outside.js" }),
      entry({ file: "/abs.js" }),
      entry({ version: "^1.0.0" }),
      entry({ rule: "*" }),
      entry({ sha256: "abc" }),
      entry({ reason: " " }),
      entry({ expires: "2027-12-31" }),
      entry({ expires: "soon" }),
      entry({ paths: ["x"] }),
      "x",
    ];
    const r = parseGuardDogExceptions(bad, NOW);
    assert.equal(r.exceptions.length, 0);
    assert.equal(r.problems.length, bad.length);
    assert.deepEqual(parseGuardDogExceptions({}, NOW).problems, [
      "guarddog-exceptions.json must hold a list",
    ]);
  });
});

describe("guardDogWaiver", () => {
  it("covers a reviewed finding and says until when", async () => {
    await withRepo([entry()], async (root) => {
      const r = await classify(root);
      assert.equal(r.status, "pass");
      assert.equal(r.evidenceStatus, "complete-empty");
      assert.match(r.detail, /1 reviewed GuardDog exception\(s\).*the first ends 2027-02-25/);
    });
  });

  it("keeps failing without the file, and never covers a rule that did not run", async () => {
    await withRepo(undefined, async (root) => {
      assert.equal((await classify(root)).status, "fail");
    });
    await withRepo([entry()], async (root) => {
      const errors = { metadata_mismatch: "failed to run rule metadata_mismatch: x" };
      const waiver = await guardDogWaiver(root, NOW);
      const r = classifyGuardDog(report(undefined, undefined, errors), scope(), false, waiver);
      assert.equal(r.evidenceStatus, "partial");
      assert.match(r.detail, /^Coverage unverified: .*1 reviewed GuardDog exception/);
    });
  });

  it("does not cover another rule, another file, changed bytes or a missing install", async () => {
    await withRepo([entry()], async (root) => {
      assert.equal((await classify(root, "threat-runtime-obfuscation")).status, "fail");
      assert.equal(
        (await classify(root, undefined, "package/dist/examples/b.js:1")).status,
        "fail",
      );
      const file = join(root, "node_modules", "@scope", "fixture", "dist", "examples", "a.js");
      writeFileSync(file, SOURCE + "fetch('https://example.invalid');\n");
      const changed = await classify(root);
      assert.equal(changed.status, "fail");
      assert.match(changed.detail, /not applied, file differs or is not installed/);
      rmSync(join(root, "node_modules"), { recursive: true });
      assert.equal((await classify(root)).status, "fail");
    });
  });

  it("does not cover another installed version", async () => {
    await withRepo([entry()], async (root) => {
      const manifest = join(root, "node_modules", "@scope", "fixture", "package.json");
      writeFileSync(manifest, '{"name":"@scope/fixture","version":"1.0.1"}');
      assert.equal((await classify(root)).status, "fail");
    });
  });

  it("stops covering the day after the entry expires", async () => {
    await withRepo([entry()], async (root) => {
      const last = new Date("2027-02-25T23:00:00Z");
      assert.equal((await classify(root, undefined, undefined, last)).status, "pass");
      const late = await classify(root, undefined, undefined, new Date("2027-02-26T00:00:01Z"));
      assert.equal(late.status, "fail");
      assert.match(late.detail, /not applied, expired 2027-02-25/);
    });
  });

  it("names a file that is not JSON and applies nothing", async () => {
    await withRepo(undefined, async (root) => {
      writeFileSync(join(root, GUARDDOG_EXCEPTIONS_FILE), "{");
      const r = await classify(root);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /guarddog-exceptions\.json is not valid JSON/);
    });
  });
});
