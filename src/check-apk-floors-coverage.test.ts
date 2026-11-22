import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { checkApkFloors } from "./check-apk-floors.js";
import { gateStatus } from "./check-security.js";
import { secdbFixture, tarOf } from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ORIGIN = "P:codec-lib\nV:2-r0\no:codec\n\n";
const FIXES = [{ pkg: { name: "codec", secfixes: { "2-r0": ["CVE-2026-12345"] } } }];

async function inspect(
  options: {
    mainIndex?: string;
    communityIndex?: string;
    mainPackages?: unknown[];
    communityPackages?: unknown[];
    floors?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "kit-apk-coverage-"));
  const seen: string[] = [];
  try {
    writeFileSync(
      join(root, "Dockerfile"),
      `FROM alpine:3.24\nRUN apk add ${options.floors ?? "'codec-lib>=1-r0'"}\n`,
    );
    const result = await checkApkFloors(
      root,
      async (url) => {
        seen.push(url);
        if (url.endsWith("/main.json")) return secdbFixture("v3.24", "main", options.mainPackages);
        if (url.endsWith("/community.json"))
          return secdbFixture("v3.24", "community", options.communityPackages ?? FIXES);
        if (url.endsWith("/main/x86_64/APKINDEX.tar.gz"))
          return gzipSync(tarOf({ APKINDEX: options.mainIndex ?? "" }));
        if (url.endsWith("/community/x86_64/APKINDEX.tar.gz"))
          return gzipSync(tarOf({ APKINDEX: options.communityIndex ?? ORIGIN }));
        throw new Error(`Unexpected URL: ${url}`);
      },
      {},
    );
    return { result, seen };
  } finally {
    rmTemp(root);
  }
}

it("resolves a community subpackage and names its source advisory", async () => {
  const { result, seen } = await inspect();
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.notEqual(result.didNotRun, true);
  assert.match(result.detail, /CVE-2026-12345/);
  assert.ok(
    seen.includes("https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/APKINDEX.tar.gz"),
  );
});

it("passes a covered fixed community floor", async () => {
  const { result } = await inspect({ floors: "'codec-lib>=2-r0'" });
  assert.equal(result.status, "pass");
  assert.notEqual(result.didNotRun, true);
  assert.equal(gateStatus(result), "pass");
});

it("keeps unrelated multi-origin packages unresolved without invalidating a covered floor", async () => {
  const alternatives =
    "P:dotnet-host\nV:8-r0\no:dotnet8-runtime\n\nP:dotnet-host\nV:9-r0\no:dotnet9-runtime\n\n";
  const { result } = await inspect({
    communityIndex: ORIGIN + alternatives,
    floors: "'codec-lib>=2-r0'",
  });
  assert.equal(result.status, "pass");
  assert.notEqual(result.didNotRun, true);
  assert.equal(gateStatus(result), "pass");
  const requested = await inspect({
    communityIndex: ORIGIN + alternatives,
    floors: "'dotnet-host>=8-r0'",
  });
  assert.equal(requested.result.status, "warn");
  assert.equal(requested.result.didNotRun, true);
  assert.equal(gateStatus(requested.result), "fail");
});

for (const [name, communityIndex] of [
  ["missing requested package", ""],
  ["unknown origin", "P:codec-lib\nV:2-r0\n\n"],
  ["missing version", "P:codec-lib\no:codec\n\n"],
  ["malformed line", ORIGIN + "not-an-index\n"],
  ["conflicting origins", ORIGIN + "P:codec-lib\nV:1-r0\no:other\n\n"],
] as const) {
  it(`keeps ${name} unverified`, async () => {
    const { result } = await inspect({ communityIndex });
    assert.equal(result.status, "warn");
    assert.equal(result.didNotRun, true);
    assert.match(result.detail, /unverified/);
    assert.equal(gateStatus(result), "fail");
  });
}

it("does not infer the package name as its unknown origin", async () => {
  const { result } = await inspect({
    communityIndex: "P:codec\nV:2-r0\n\n",
    floors: "'codec>=2-r0'",
  });
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
});

it("keeps conflicting origins across repositories unverified", async () => {
  const { result } = await inspect({ mainIndex: ORIGIN.replace("o:codec", "o:other") });
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
});

it("unions source advisories across repositories instead of discarding community fixes", async () => {
  const { result } = await inspect({
    mainIndex: ORIGIN,
    mainPackages: [{ pkg: { name: "codec", secfixes: {} } }],
  });
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.match(result.detail, /CVE-2026-12345/);
});

it("keeps an unparsed version unverified", async () => {
  const { result } = await inspect({ mainIndex: ORIGIN, floors: "'codec-lib>=${VER}'" });
  assert.equal(result.status, "warn");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /not parsed/);
});

it("preserves known findings while another advisory version cannot be compared", async () => {
  const { result } = await inspect({
    mainIndex: ORIGIN,
    communityPackages: [
      {
        pkg: {
          name: "codec",
          secfixes: { "2-r0": ["CVE-2026-12345"], future: ["CVE-2026-54321"] },
        },
      },
    ],
  });
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /CVE-2026-12345/);
  assert.match(result.detail, /unverified/);
});

it("retains a known vulnerability when a different requested package is unresolved", async () => {
  const { result } = await inspect({
    mainIndex: ORIGIN,
    floors: "'codec-lib>=1-r0' 'missing>=1-r0'",
  });
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /CVE-2026-12345/);
  assert.match(result.detail, /missing/);
});
