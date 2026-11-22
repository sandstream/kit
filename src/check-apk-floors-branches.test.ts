import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApkFloors } from "./check-apk-floors.js";
import { gateStatus } from "./check-security.js";
import {
  alpineFixtureFetcher,
  apkIndexFixture,
  secdbFixture,
  secdbIndexFixture,
} from "./apk-index.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ORIGIN = "P:binary\nV:2-r0\no:source\n";
const OLDER = "CVE-2026-12345";
const NEWER = "CVE-2026-54321";

async function inspect(
  options: {
    stages?: string[];
    failedBranches?: string[];
    malformed?: boolean;
    latestUnavailable?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "kit-apk-branches-"));
  const seen: string[] = [];
  try {
    const stages = options.stages ?? ["alpine:3.23", "alpine:3.24"];
    writeFileSync(
      join(root, "Dockerfile"),
      stages.map((image) => `FROM ${image}\nRUN apk add 'binary>=1-r0'\n`).join("\n"),
    );
    const result = await checkApkFloors(
      root,
      alpineFixtureFetcher(async (url) => {
        seen.push(url);
        if (url === "https://secdb.alpinelinux.org/") {
          if (options.latestUnavailable) throw new Error("index unavailable");
          return secdbIndexFixture("v3.24");
        }
        const branch = /\/(v3\.\d+)\//.exec(url)?.[1];
        if (!branch) throw new Error(`Unexpected URL: ${url}`);
        if (url.endsWith("/community.json")) {
          if (options.failedBranches?.includes(branch)) {
            if (options.malformed) return Buffer.from("{incomplete");
            throw new Error("community unavailable");
          }
          return secdbFixture(branch, "community");
        }
        if (url.endsWith("/main.json"))
          return secdbFixture(branch, "main", [
            {
              pkg: { name: "source", secfixes: { "2-r0": [branch === "v3.23" ? OLDER : NEWER] } },
            },
          ]);
        if (url.endsWith("/main/x86_64/APKINDEX.tar.gz")) return apkIndexFixture(branch, ORIGIN);
        if (url.endsWith("/community/x86_64/APKINDEX.tar.gz")) return apkIndexFixture(branch, "");
        throw new Error(`Unexpected URL: ${url}`);
      }),
      {},
    );
    return { result, seen };
  } finally {
    rmTemp(root);
  }
}

it("reports both branch advisories when both comparisons complete", async () => {
  const { result } = await inspect();
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.notEqual(result.didNotRun, true);
  assert.ok(result.detail.includes(OLDER));
  assert.ok(result.detail.includes(NEWER));
});

for (const failedBranch of ["v3.23", "v3.24"]) {
  for (const malformed of [false, true]) {
    it(`retains the other branch finding when ${failedBranch} is ${malformed ? "malformed" : "unreachable"}`, async () => {
      const { result } = await inspect({ failedBranches: [failedBranch], malformed });
      assert.equal(result.status, "warn");
      assert.equal(result.severity, "high");
      assert.equal(result.didNotRun, true);
      assert.ok(result.detail.includes(failedBranch));
      assert.ok(result.detail.includes(failedBranch === "v3.23" ? NEWER : OLDER));
      assert.equal(gateStatus(result), "fail");
    });
  }
}

for (const stages of [
  ["alpine:3.23", "node:22-alpine"],
  ["node:22-alpine", "alpine:3.23"],
]) {
  it(`retains the explicit branch when the latest lookup fails after ${stages[0]}`, async () => {
    const { result, seen } = await inspect({ stages, latestUnavailable: true });
    assert.equal(result.severity, "high");
    assert.equal(result.didNotRun, true);
    assert.ok(result.detail.includes(OLDER));
    assert.match(result.detail, /index unavailable/);
    assert.equal(seen.filter((url) => url.includes("/v3.23/")).length, 4);
    assert.equal(gateStatus(result), "fail");
  });
}

it("retains findings and both source errors when every branch is partial", async () => {
  const { result } = await inspect({ failedBranches: ["v3.23", "v3.24"] });
  assert.equal(result.status, "warn");
  assert.equal(result.severity, "high");
  assert.equal(result.hasFindings, true);
  assert.ok(result.detail.includes(OLDER));
  assert.ok(result.detail.includes(NEWER));
  assert.equal(result.didNotRun, true);
  assert.match(result.detail, /community unavailable/);
  assert.ok(result.detail.includes("v3.23"));
  assert.ok(result.detail.includes("v3.24"));
  assert.equal(gateStatus(result), "fail");
});
