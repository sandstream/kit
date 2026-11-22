/**
 * The I/O half of the apk-floor check, with an injected fetcher: no socket is opened. Air-gap
 * mode skips it, an unreachable source is "did not run" (never a pass), and a low floor warns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APK_FLOORS_NAME, checkApkFloors, type ApkFetcher } from "./check-apk-floors.js";
import {
  alpineFixtureFetcher,
  alpineHttpFixture,
  apkIndexFixture,
  secdbFixture,
  secdbIndexFixture,
} from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SECDB_MAIN = secdbFixture("v3.24", "main", [
  { pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } },
]);
const INDEX = apkIndexFixture("v3.24", "P:libexpat\nV:2.10.0-r0\no:expat\n");

function fakeFetcher(seen: string[]): ApkFetcher {
  return alpineFixtureFetcher(async (url) => {
    seen.push(url);
    if (url === "https://secdb.alpinelinux.org/") return secdbIndexFixture("v3.24");
    if (url.endsWith("/v3.24/main.json")) return SECDB_MAIN;
    if (url.endsWith("/v3.24/community.json")) return secdbFixture("v3.24", "community");
    if (url.endsWith("/v3.24/main/x86_64/APKINDEX.tar.gz")) return INDEX;
    if (url.endsWith("/v3.24/community/x86_64/APKINDEX.tar.gz"))
      return apkIndexFixture("v3.24", "");
    throw new Error(`unexpected ${url}`);
  });
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

  it("names the branch and the four sources a pass was judged against", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    t.after(() => rmTemp(dir));
    const r = await checkApkFloors(dir, fakeFetcher([]), {});
    assert.equal(r.status, "pass");
    assert.match(
      r.detail,
      /checked on v3\.24 against secdb main\+community and APKINDEX main\+community/,
    );
  });
});

const CHMOD_SKIP =
  process.platform === "win32" || process.getuid?.() === 0
    ? "chmod 000 does not deny reads on Windows or to root"
    : false;

describe("check apk floors with a Dockerfile it cannot read", { skip: CHMOD_SKIP }, () => {
  it("keeps the comparison unverified instead of dropping that file's floors", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    mkdirSync(join(dir, "worker"));
    const locked = join(dir, "worker", "Dockerfile");
    writeFileSync(locked, "FROM alpine:3.24\nRUN apk add 'zlib>=1.0-r0'\n");
    chmodSync(locked, 0o000);
    t.after(() => {
      chmodSync(locked, 0o600);
      rmTemp(dir);
    });
    const r = await checkApkFloors(dir, fakeFetcher([]), {});
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /not read: worker\/Dockerfile/);
  });

  it("does not call a repository floor-free when its only Dockerfile cannot be read", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    const only = join(dir, "Dockerfile");
    chmodSync(only, 0o000);
    t.after(() => {
      chmodSync(only, 0o600);
      rmTemp(dir);
    });
    const r = await checkApkFloors(dir, fakeFetcher([]), {});
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /not read: Dockerfile/);
  });
});

describe("check apk floors with the default transport", () => {
  it("keeps a partial HTTP source unverified even when its JSON is valid", async (t) => {
    const dir = repoWith("libexpat>=2.8.5-r0");
    t.after(() => rmTemp(dir));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      calls++;
      if (url.endsWith("/main.json")) return new Response('{"packages":[]}', { status: 206 });
      return alpineHttpFixture(await fakeFetcher([])(url));
    });
    const result = await checkApkFloors(dir, undefined, {});
    assert.equal(result.status, "warn");
    assert.equal(result.didNotRun, true);
    assert.match(result.detail, /HTTP 206/);
    assert.equal(result.evidenceStatus, "partial");
    assert.equal(result.evidenceSources?.[1]?.status, "partial");
    assert.equal(calls, 5);
  });

  it("uses the default transport retry before judging the complete source data", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    t.after(() => rmTemp(dir));
    let calls = 0;
    const seen: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (++calls === 1)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        });
      return alpineHttpFixture(await fakeFetcher(seen)(url));
    });
    const observed = await checkApkFloors(dir, undefined, {});
    assert.equal(observed.status, "pass");
    assert.notEqual(observed.didNotRun, true);
    assert.equal(calls, 6);
    assert.equal(seen.length, 5);
  });

  it("keeps an exhausted default fetch unverified with its network cause", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    t.after(() => rmTemp(dir));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      });
    });
    const observed = await checkApkFloors(dir, undefined, {});
    assert.equal(observed.status, "warn");
    assert.equal(observed.didNotRun, true);
    assert.match(observed.detail, /3 attempts.*ETIMEDOUT/);
    assert.equal(calls, 3);
  });

  it("refuses malformed source content without retrying successful HTTP responses", async (t) => {
    const dir = repoWith("libexpat>=2.10.0-r0");
    t.after(() => rmTemp(dir));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      calls++;
      if (url.endsWith("/main.json")) return new Response("{invalid");
      return alpineHttpFixture(await fakeFetcher([])(url));
    });
    const observed = await checkApkFloors(dir, undefined, {});
    assert.equal(observed.status, "warn");
    assert.equal(observed.didNotRun, true);
    assert.equal(calls, 5);
  });
});
