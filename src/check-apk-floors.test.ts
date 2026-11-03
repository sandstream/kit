/**
 * The I/O half of the apk-floor check, with an injected fetcher: no socket is opened. Air-gap
 * mode skips it, an unreachable source is "did not run" (never a pass), and a low floor warns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { APK_FLOORS_NAME, checkApkFloors, type ApkFetcher } from "./check-apk-floors.js";
import { tarOf } from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SECDB_MAIN = JSON.stringify({
  packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } }],
});
const INDEX = gzipSync(tarOf({ APKINDEX: "P:libexpat\nV:2.10.0-r0\no:expat\n" }));

function fakeFetcher(seen: string[]): ApkFetcher {
  return async (url) => {
    seen.push(url);
    if (url === "https://secdb.alpinelinux.org/") return Buffer.from('<a href="v3.24/">v3.24/</a>');
    if (url.endsWith("/v3.24/main.json")) return Buffer.from(SECDB_MAIN);
    if (url.endsWith("/v3.24/community.json")) return Buffer.from('{"packages":[]}');
    if (url.endsWith("/v3.24/main/x86_64/APKINDEX.tar.gz")) return INDEX;
    throw new Error(`unexpected ${url}`);
  };
}

function repoWith(floor: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-apk-floors-"));
  writeFileSync(
    join(dir, "Dockerfile"),
    `FROM node:22-alpine\nRUN apk add --no-cache --upgrade '${floor}'\n`,
  );
  return dir;
}

describe("check apk floors", () => {
  it("warns on a floor below an Alpine fix, naming the CVE and the floor to raise to", async (t) => {
    const dir = repoWith("libexpat>=2.8.5-r0");
    t.after(() => rmTemp(dir));
    const seen: string[] = [];
    const r = await checkApkFloors(dir, fakeFetcher(seen), {});
    assert.equal(r.name, APK_FLOORS_NAME);
    assert.equal(r.status, "warn");
    assert.match(r.detail, /libexpat>=2\.8\.5-r0 admits versions fixed in 2\.10\.0-r0 on v3\.24/);
    assert.match(r.detail, /CVE-2026-117610/);
    assert.match(r.detail, /v3\.24 \(newest stable\) was assumed/);
    assert.match(r.suggestion ?? "", /libexpat>=2\.10\.0-r0/);
    assert.ok(seen.every((u) => /^https:\/\/(secdb|dl-cdn)\.alpinelinux\.org\//.test(u)));
  });

  it("passes a floor at the fix", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    t.after(() => rmTemp(dir));
    const r = await checkApkFloors(dir, fakeFetcher([]), {});
    assert.equal(r.status, "pass");
  });

  it("fetches nothing in air-gap mode and says the floors are unverified", async (t) => {
    const dir = repoWith("libexpat>=2.8.5-r0");
    t.after(() => rmTemp(dir));
    const seen: string[] = [];
    const r = await checkApkFloors(dir, fakeFetcher(seen), { KIT_AIRGAP: "1" });
    assert.equal(r.status, "skip");
    assert.match(r.detail, /unverified/);
    assert.deepEqual(seen, []);
  });

  it("is a check that did not run, not a pass, when secdb is unreachable", async (t) => {
    const dir = repoWith("libexpat>=2.8.5-r0");
    t.after(() => rmTemp(dir));
    const r = await checkApkFloors(
      dir,
      async () => {
        throw new Error("offline");
      },
      {},
    );
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /\(unverified\): offline/);
  });

  it("skips a repository without apk floors", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-apk-floors-"));
    t.after(() => rmTemp(dir));
    const r = await checkApkFloors(dir, fakeFetcher([]), {});
    assert.equal(r.status, "skip");
  });
});
