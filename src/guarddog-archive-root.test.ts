import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { rescanArchiveRoots, type ArchiveRootTools } from "./guarddog-archive-root.js";
import { classifyGuardDog, guardDogScope } from "./guarddog.js";
import { archive } from "./incoming-trust/npm-artifact-archive.test-support.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const NAME = "@scope/fixture";
const MANIFEST = '{"name":"@scope/fixture","version":"1.0.0"}';
const TARBALL = "https://registry.npmjs.org/@scope/fixture/-/fixture-1.0.0.tgz";
const DOC_URL = "https://registry.npmjs.org/@scope%2Ffixture/1.0.0";
const ROOT_ERROR =
  "failed to run rule metadata_mismatch: package.json was not found at an expected npm archive root: /tmp/x/package/package.json, /tmp/x/fixture/package.json";

const tarball = (root: string) =>
  archive([
    { path: `${root}/`, dir: true },
    { path: `${root}/package.json`, body: MANIFEST },
    { path: `${root}/index.d.ts`, body: "export {};\n" },
  ]);
const integrity = (bytes: Buffer) =>
  "sha512-" + createHash("sha512").update(bytes).digest("base64");

function verify(errors: Record<string, string> = { metadata_mismatch: ROOT_ERROR }): ExecResult {
  const result = { issues: 0, errors, results: { "threat-runtime-obfuscation": null } };
  const stdout = JSON.stringify([{ dependency: NAME, version: "1.0.0", result }]);
  return { exitCode: 0, ok: true, stdout, stderr: "" };
}

/** A root folder whose package.json path comes from a pax header, as long paths do. */
function paxTarball(root: string): Buffer {
  const record = ` path=${root}/package.json\n`;
  const body = `${record.length + 3}${record}`;
  const tar = gunzipSync(
    archive([
      { path: `${root}/PaxHeader`, body },
      { path: `${root}/short-name`, body: MANIFEST },
    ]),
  );
  tar[156] = "x".charCodeAt(0);
  tar.write("        ", 148, "latin1");
  let sum = 0;
  for (const byte of tar.subarray(0, 512)) sum += byte;
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return gzipSync(tar);
}

interface Fake {
  root?: string;
  bytes?: Buffer;
  served?: Buffer;
  scan?: Partial<ExecResult>;
  ruleResult?: string | null;
}

/** Fake registry and GuardDog. Records each call, and what the scan read from its directory. */
function tools(fake: Fake = {}) {
  const bytes = fake.bytes ?? tarball(fake.root ?? "node v1");
  const doc = {
    name: NAME,
    version: "1.0.0",
    dist: { tarball: TARBALL, integrity: integrity(bytes) },
  };
  const calls: string[] = [];
  const seen: { manifest?: string; metadata?: unknown; args?: string[] } = {};
  const t: ArchiveRootTools = {
    fetch: async (url) => {
      calls.push(url);
      if (url === DOC_URL)
        return { status: "retrieved", bytes: Buffer.from(JSON.stringify(doc)), source: url };
      if (url === TARBALL) return { status: "retrieved", bytes: fake.served ?? bytes, source: url };
      return { status: "rejected", reason: "http-status", statusCode: 404 };
    },
    exec: async (_bin, args) => {
      calls.push("scan");
      seen.args = args;
      seen.manifest = readFileSync(join(args[2], "package", "package.json"), "utf8");
      seen.metadata = JSON.parse(readFileSync(args[args.indexOf("--metadata") + 1], "utf8"));
      const value = fake.ruleResult === undefined ? null : fake.ruleResult;
      const report = { issues: value ? 1 : 0, errors: {}, results: { metadata_mismatch: value } };
      return { exitCode: 0, ok: true, stdout: JSON.stringify(report), stderr: "", ...fake.scan };
    },
  };
  return { t, calls, seen, doc };
}

const scope = () => guardDogScope("npm", `{"devDependencies":{"${NAME}":"1.0.0"}}`);
const rescan = (result: ExecResult, t: ArchiveRootTools) =>
  rescanArchiveRoots("npm", result, "guarddog", 10_000, t);

describe("rescanArchiveRoots", () => {
  it("reruns the metadata rule on a normalised copy and verifies the package", async () => {
    const before = classifyGuardDog(verify(), scope());
    assert.equal(before.evidenceStatus, "partial");
    assert.match(before.detail, /Coverage unverified/);
    const { t, calls, seen, doc } = tools();
    const r = classifyGuardDog(await rescan(verify(), t), scope());
    assert.deepEqual(calls, [DOC_URL, TARBALL, "scan"]);
    assert.deepEqual(seen.args?.slice(0, 2), ["npm", "scan"]);
    assert.ok(seen.args?.includes("--rules") && seen.args.includes("metadata_mismatch"));
    assert.equal(seen.manifest, MANIFEST);
    assert.deepEqual(seen.metadata, { name: NAME, version: "1.0.0", versions: { "1.0.0": doc } });
    assert.equal(r.status, "pass");
    assert.equal(r.evidenceStatus, "complete-empty");
  });

  it("reads a manifest path from a pax header", async () => {
    const { t, seen } = tools({ bytes: paxTarball("node v1") });
    assert.equal(classifyGuardDog(await rescan(verify(), t), scope()).status, "pass");
    assert.equal(seen.manifest, MANIFEST);
  });

  it("counts a mismatch the rerun finds", async () => {
    const { t } = tools({ ruleResult: "Difference between manifest and package.json found" });
    const r = classifyGuardDog(await rescan(verify(), t), scope());
    assert.equal(r.status, "fail");
    assert.match(r.detail, /^1 malware indicator/);
    assert.doesNotMatch(r.detail, /unverified/);
  });

  it("keeps other errors of the row", async () => {
    const other = { potentially_compromised_email_domain: "failed to run rule x: refused" };
    const { t } = tools();
    const out = await rescan(verify({ metadata_mismatch: ROOT_ERROR, ...other }), t);
    const row = (JSON.parse(out.stdout) as { result: { errors: object } }[])[0];
    assert.deepEqual(row.result.errors, other);
    assert.equal(classifyGuardDog(out, scope()).evidenceStatus, "partial");
  });
});

describe("rescanArchiveRoots fails closed", () => {
  /** Whether the report came back untouched, how many scans ran, and the check's status. */
  const rerun = async (fake: Fake) => {
    const { t, calls } = tools(fake);
    const input = verify();
    const out = await rescan(input, t);
    const scans = calls.filter((c) => c === "scan").length;
    return { kept: out === input, scans, status: classifyGuardDog(out, scope()).status };
  };
  const KEPT = { kept: true, scans: 0, status: "warn" };

  it("when the tarball does not match the registry integrity", async () => {
    assert.deepEqual(await rerun({ served: tarball("other") }), KEPT);
  });

  it("when GuardDog could read the root, so the error has another cause", async () => {
    assert.deepEqual(await rerun({ root: "package" }), KEPT);
    assert.deepEqual(await rerun({ root: "fixture" }), KEPT);
  });

  it("when the archive has two roots, or a manifest of another package", async () => {
    const pkg = { path: "b/package.json", body: MANIFEST };
    const twoRoots = archive([{ path: "a/package.json", body: MANIFEST }, pkg]);
    assert.deepEqual(await rerun({ bytes: twoRoots }), KEPT);
    const other = archive([{ path: "a/package.json", body: '{"name":"x"}' }]);
    assert.deepEqual(await rerun({ bytes: other }), KEPT);
  });

  it("when the scan cannot run or reports an error", async () => {
    const sandbox = { ok: false, exitCode: 1, stdout: "", stderr: "ERROR: Kernel-level sandbox" };
    assert.deepEqual(await rerun({ scan: sandbox }), { ...KEPT, scans: 1 });
    const failed = JSON.stringify({ issues: 0, errors: { metadata_mismatch: "x" }, results: {} });
    assert.deepEqual(await rerun({ scan: { stdout: failed } }), { ...KEPT, scans: 1 });
  });

  it("when the registry document is missing, and for other errors and PyPI", async () => {
    const { t, calls } = tools();
    const missing = {
      ...t,
      fetch: async () => ({ status: "rejected", reason: "timeout" }) as const,
    };
    const input = verify();
    assert.equal(await rescan(input, missing), input);
    const other = verify({ metadata_mismatch: "failed to run rule metadata_mismatch: boom" });
    assert.equal(await rescan(other, t), other);
    const odd = { ...input, stdout: input.stdout.replace('"@scope/fixture"', '"../x/y"') };
    assert.equal(await rescan(odd, t), odd);
    assert.equal(await rescanArchiveRoots("pypi", input, "guarddog", 10_000, t), input);
    assert.deepEqual(calls, []);
  });
});
