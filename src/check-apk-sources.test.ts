import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  alpineFixtureFetcher,
  apkIndexFixture,
  secdbIndexFixture,
} from "./apk-index.test-support.js";
import { checkApkFloors, type ApkFetcher } from "./check-apk-floors.js";
import { securityCheckToJson } from "./check-run.js";
import { gateStatus } from "./check-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const branch = "v3.24";
const advisory = "CVE-2026-12345";
const main = { distroversion: branch, reponame: "main", packages: [] };
const community = { distroversion: branch, reponame: "community", packages: [] };
const fixes = [{ pkg: { name: "example-source", secfixes: { "2-r0": [advisory] } } }];
const index = apkIndexFixture(branch, "P:example-lib\nV:2-r0\no:example-source\n");
const emptyIndex = apkIndexFixture(branch, "");

function repo(t: TestContext, version = "2-r0", base = "alpine:3.24"): string {
  const root = mkdtempSync(join(tmpdir(), "kit-alpine-sources-"));
  t.after(() => rmTemp(root));
  writeFileSync(join(root, "Dockerfile"), `FROM ${base}\nRUN apk add 'example-lib>=${version}'\n`);
  return root;
}

function sources(overrides: Partial<Record<string, Buffer | null>> = {}): ApkFetcher {
  const stock: Record<string, Buffer> = {
    "https://secdb.alpinelinux.org/": secdbIndexFixture("v3.24"),
    "main.json": Buffer.from(JSON.stringify(main)),
    "community.json": Buffer.from(JSON.stringify(community)),
    "main/x86_64/APKINDEX.tar.gz": index,
    "community/x86_64/APKINDEX.tar.gz": emptyIndex,
  };
  return alpineFixtureFetcher(async (url) => {
    const source = Object.keys(stock).find((name) => url.endsWith(name));
    if (!source) throw new Error("Unexpected source in fixture");
    const data = source in overrides ? overrides[source] : stock[source];
    if (!data) throw new Error("Source unavailable");
    return data;
  });
}

it("reports the exact scope and complete coverage through the check JSON mapping", async (t) => {
  const row = securityCheckToJson(await checkApkFloors(repo(t), sources(), {}));
  assert.equal(row.status, "pass");
  assert.equal(row.evidenceStatus, "complete-empty");
  assert.equal(row.evidenceSources?.length, 4);
  const mainIndex = row.evidenceSources?.find(
    (source) => source.kind === "apkindex" && source.repository === "main",
  );
  assert.deepEqual(mainIndex, {
    kind: "apkindex",
    url: "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz",
    branch,
    repository: "main",
    architecture: "x86_64",
    status: "complete",
    lastModified: mainIndex?.lastModified,
  });
  assert.match(mainIndex.lastModified ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.evidenceSources?.at(-1)?.status, "complete-empty");
});

it("refuses complete archives with foreign scope or unsupported descriptions", async (t) => {
  const root = repo(t);
  const record = "P:example-lib\nV:2-r0\no:example-source\n";
  const fixtures = [
    { archive: apkIndexFixture("v3.23", record), status: "malformed", reason: /different branch/ },
    {
      archive: apkIndexFixture(branch, record, "aarch64"),
      status: "malformed",
      reason: /requires A:x86_64/,
    },
    {
      archive: apkIndexFixture("edge", record),
      status: "unsupported",
      reason: /unsupported APKINDEX DESCRIPTION/,
    },
  ];
  for (const { archive, status, reason } of fixtures) {
    const observed = await checkApkFloors(
      root,
      sources({ "main/x86_64/APKINDEX.tar.gz": archive }),
      {},
    );
    assert.equal(gateStatus(observed), "fail");
    assert.equal(observed.evidenceStatus, "partial");
    assert.equal(observed.evidenceSources?.[1]?.status, status);
    assert.match(observed.detail, reason);
  }
});

it("distinguishes missing, malformed and stale timestamps from success", async (t) => {
  const root = repo(t);
  const defaultSources = sources();
  const day = 24 * 60 * 60 * 1000;
  const cases = [
    { lastModified: null, status: "missing", message: /missing HTTP Last-Modified/ },
    { lastModified: "no date", status: "malformed", message: /invalid HTTP Last-Modified/ },
    {
      lastModified: new Date(Date.now() + day).toUTCString(),
      status: "malformed",
      message: /in the future/,
    },
    {
      lastModified: new Date(Date.now() - 31 * day).toUTCString(),
      status: "stale",
      message: /more than 30 days old/,
    },
  ];
  for (const { lastModified, status, message } of cases) {
    const observed = await checkApkFloors(
      root,
      async (url) => {
        const source = await defaultSources(url);
        return url.endsWith("/main/x86_64/APKINDEX.tar.gz") ? { ...source, lastModified } : source;
      },
      {},
    );
    assert.equal(gateStatus(observed), "fail");
    assert.equal(observed.evidenceStatus, "partial");
    assert.equal(observed.evidenceSources?.[1]?.status, status);
    assert.match(observed.detail, message);
    assert.equal(observed.evidenceSources?.[0]?.status, "complete-empty");
  }
});

it("rejects a secdb result for another branch or repository", async (t) => {
  const root = repo(t);
  for (const foreign of [
    { ...main, distroversion: "v3.23" },
    { ...main, reponame: "community" },
  ]) {
    const result = await checkApkFloors(
      root,
      sources({ "main.json": Buffer.from(JSON.stringify(foreign)) }),
      {},
    );
    assert.equal(result.didNotRun, true, result.detail);
    assert.equal(gateStatus(result), "fail");
    assert.match(result.detail, /main secdb/);
  }
});

it("retains a validated main finding when its peer source is unavailable", async (t) => {
  const root = repo(t, "1-r0");
  const fetcher = sources({
    "main.json": Buffer.from(JSON.stringify({ ...main, packages: fixes })),
    "community.json": null,
  });
  const row = await checkApkFloors(root, fetcher, {});
  assert.equal(row.didNotRun, true);
  assert.equal(row.hasFindings, true);
  assert.equal(row.scanIncomplete, true);
  assert.equal(row.severity, "high");
  assert.match(row.detail, new RegExp(advisory));
  assert.match(row.detail, /community secdb/);
  assert.match(row.detail, /validated sources: v3\.24 main secdb/);
});

it("refuses an ambiguous duplicate field in a secdb response", async (t) => {
  const root = repo(t);
  const duplicate = JSON.stringify({ ...main, packages: fixes }).replace(/}$/, ',"packages":[]}');
  const result = await checkApkFloors(root, sources({ "main.json": Buffer.from(duplicate) }), {});
  assert.equal(result.didNotRun, true, result.detail);
  assert.match(result.detail, /duplicate object keys/i);
});

it("refuses a stable branch index that contains invalid UTF-8", async (t) => {
  const root = repo(t, "2-r0", "node:22-alpine");
  const route = "https://secdb.alpinelinux.org/";
  const body = Buffer.concat([secdbIndexFixture("v3.24"), Buffer.from([0xff])]);
  const result = await checkApkFloors(root, sources({ [route]: body }), {});
  assert.equal(result.didNotRun, true, result.detail);
  assert.match(result.detail, /invalid UTF-8/);
});

it(
  "treats an undiscovered subdirectory as incomplete coverage",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0
        ? "chmod cannot deny reads on this runner"
        : false,
  },
  async (t) => {
    const root = repo(t);
    const directory = join(root, "worker");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "Dockerfile"),
      "FROM alpine:3.24\nRUN apk add 'example-lib>=1-r0'\n",
    );
    chmodSync(directory, 0);
    try {
      const result = await checkApkFloors(root, sources(), {});
      assert.equal(result.didNotRun, true, result.detail);
      assert.match(result.detail, /worker/);
    } finally {
      chmodSync(directory, 0o700);
    }
  },
);

it("reports a directory beyond the search depth as unverified", async (t) => {
  const root = repo(t);
  const directory = join(root, "one", "two", "three", "four");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "Dockerfile"),
    "FROM alpine:3.24\nRUN apk add 'example-lib>=1-r0'\n",
  );
  const result = await checkApkFloors(root, sources(), {});
  assert.equal(result.didNotRun, true, result.detail);
  assert.match(result.detail, /depth limit/);
  const offline = await checkApkFloors(root, async () => assert.fail("unexpected network lookup"), {
    KIT_AIRGAP: "1",
  });
  assert.equal(offline.didNotRun, true);
  assert.equal(gateStatus(offline), "fail");
  assert.match(offline.detail, /air-gap.*depth limit/);
});

it("records the Dockerfile limit and retains the floors already found", async (t) => {
  const root = repo(t, "1-r0");
  for (let index = 0; index < 50; index++) {
    writeFileSync(
      join(root, "Dockerfile." + index),
      "FROM alpine:3.24\nRUN apk add 'example-lib>=1-r0'\n",
    );
  }
  const currentMain = Buffer.from(JSON.stringify({ ...main, packages: fixes }));
  const result = await checkApkFloors(root, sources({ "main.json": currentMain }), {});
  assert.equal(result.didNotRun, true);
  assert.equal(result.hasFindings, true);
  assert.match(result.detail, /Dockerfile limit/);
  assert.match(result.detail, new RegExp(advisory));
});

it("rejects package names that lose their identity during an APKINDEX join", async (t) => {
  const root = repo(t);
  const inconsistent = [{ pkg: { name: "example-source ", secfixes: { "3-r0": [advisory] } } }];
  const response = Buffer.from(JSON.stringify({ ...main, packages: inconsistent }));
  const row = await checkApkFloors(root, sources({ "main.json": response }), {});
  assert.equal(row.didNotRun, true);
  assert.match(row.detail, /invalid package name/);
});

it("labels a finding preliminary when a missing index can change the package origin", async (t) => {
  const root = repo(t, "1-r0");
  const localMain = Buffer.from(JSON.stringify({ ...main, packages: fixes }));
  const partial = await checkApkFloors(
    root,
    sources({
      "main.json": localMain,
      "community/x86_64/APKINDEX.tar.gz": null,
    }),
    {},
  );
  assert.equal(partial.didNotRun, true);
  assert.equal(partial.hasFindings, undefined);
  assert.equal(partial.severity, "medium");
  assert.match(partial.detail, /preliminary findings with incomplete origin data/);
  assert.match(partial.detail, new RegExp(advisory));

  const otherOrigin = apkIndexFixture(branch, "P:example-lib\nV:2-r0\no:other-source\n");
  const compared = await checkApkFloors(
    root,
    sources({
      "main.json": localMain,
      "community/x86_64/APKINDEX.tar.gz": otherOrigin,
    }),
    {},
  );
  assert.equal(compared.didNotRun, true);
  assert.match(compared.detail, /origin unresolved/);
  assert.doesNotMatch(compared.detail, new RegExp(advisory));
});

it("keeps an incomplete stable index unverified without fetching a candidate branch", async (t) => {
  const root = repo(t, "2-r0", "node:22-alpine");
  const route = "https://secdb.alpinelinux.org/";
  const fragment = Buffer.from('<a href="v3.24/">v3.24/</a>');
  const mock = sources({ [route]: fragment });
  const called: string[] = [];
  const row = await checkApkFloors(
    root,
    (url) => {
      called.push(url);
      return mock(url);
    },
    {},
  );
  assert.equal(row.didNotRun, true);
  assert.match(row.detail, /not a complete directory listing/);
  assert.deepEqual(called, [route]);
});
