import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkApkFloors } from "./check-apk-floors.js";
import { gateStatus } from "./check-security.js";
import { secdbFixture, secdbIndexFixture, tarOf } from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const VALID_MAIN = {
  distroversion: "v3.24",
  reponame: "main",
  packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } }],
};
const INDEX = gzipSync(tarOf({ APKINDEX: "P:libexpat\nV:2.10.0-r0\no:expat\n" }));

async function inspectSources(main: unknown, index = INDEX, floor = "2.8.5-r0") {
  const root = mkdtempSync(join(tmpdir(), "kit-apk-integrity-"));
  try {
    writeFileSync(
      join(root, "Dockerfile"),
      `FROM node:22-alpine\nRUN apk add 'libexpat>=${floor}'\n`,
    );
    return await checkApkFloors(
      root,
      async (url) => {
        if (url === "https://secdb.alpinelinux.org/") return secdbIndexFixture("v3.24");
        if (url.endsWith("/main.json"))
          return Buffer.isBuffer(main) ? main : Buffer.from(JSON.stringify(main));
        if (url.endsWith("/community.json")) return secdbFixture("v3.24", "community");
        if (url.endsWith("/APKINDEX.tar.gz")) return index;
        throw new Error("Unexpected source URL");
      },
      {},
    );
  } finally {
    rmTemp(root);
  }
}

it("compares a complete source and reports the known vulnerable floor", async () => {
  const result = await inspectSources(VALID_MAIN);
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.notEqual(result.didNotRun, true);
  assert.match(result.detail, /CVE-2026-117610/);
});

it("passes a fixed floor after a complete source comparison", async () => {
  const result = await inspectSources(VALID_MAIN, INDEX, "2.10.0-r0");
  assert.equal(result.status, "pass");
  assert.notEqual(result.didNotRun, true);
});

it("keeps a malformed fix record unverified instead of dropping the vulnerability", async () => {
  const result = await inspectSources({
    ...VALID_MAIN,
    packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": "CVE-2026-117610" } } }],
  });
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /unverified/);
});

it("keeps a truncated tar body unverified despite complete gzip framing", async () => {
  const truncated = gzipSync(gunzipSync(INDEX).subarray(0, 522));
  const result = await inspectSources(VALID_MAIN, truncated);
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /unverified/);
});

it("refuses invalid UTF-8 before replacement bytes can hide a source package", async () => {
  const malformed = Buffer.from(JSON.stringify(VALID_MAIN));
  malformed[malformed.indexOf("expat") + 1] = 255;
  const result = await inspectSources(malformed);
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /UTF-8/);
});

it("refuses a hidden gzip member instead of passing the complete visible index", async () => {
  const hidden = Buffer.concat([INDEX, Buffer.alloc(1), INDEX]);
  const result = await inspectSources(VALID_MAIN, hidden, "2.10.0-r0");
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /unconsumed gzip/);
  assert.equal(gateStatus(result), "fail");
});
