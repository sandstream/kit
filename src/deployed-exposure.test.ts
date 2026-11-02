import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { kitConfig } from "./config.js";
import { lockedPackagesAt, tagDeployed, tagWithDeployed } from "./deployed-exposure.js";
import { osvFinding } from "./osv-summary.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const lock = (packages: Record<string, { version: string }>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } });

/** A real repo: commit A has lodash 4.17.20 and a scoped package, commit B upgrades lodash. */
function repo(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-deployed-exposure-"));
  git(dir, "init", "-q");
  writeFileSync(
    join(dir, "package-lock.json"),
    lock({
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/@scope/pkg": { version: "1.0.0" },
      "node_modules/a/node_modules/nested": { version: "2.0.0" },
    }),
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "a");
  const a = git(dir, "rev-parse", "HEAD");
  writeFileSync(
    join(dir, "package-lock.json"),
    lock({ "node_modules/lodash": { version: "4.17.21" } }),
  );
  git(dir, "commit", "-q", "-am", "b");
  return { dir, a, b: git(dir, "rev-parse", "HEAD") };
}

describe("lockedPackagesAt", () => {
  it("reads name@version pairs from package-lock.json at that commit, not the working tree", async () => {
    const { dir, a, b } = repo();
    try {
      const atA = await lockedPackagesAt(dir, a);
      assert.ok(atA.ok);
      assert.deepEqual([...atA.packages].sort(), [
        "@scope/pkg@1.0.0",
        "lodash@4.17.20",
        "nested@2.0.0",
      ]);
      const atB = await lockedPackagesAt(dir, b);
      assert.ok(atB.ok);
      assert.deepEqual([...atB.packages], ["lodash@4.17.21"]);
    } finally {
      rmTemp(dir);
    }
  });

  it("reads the lockfile of the working directory when it is a subdirectory of the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-deployed-exposure-sub-"));
    try {
      git(dir, "init", "-q");
      mkdirSync(join(dir, "app"));
      writeFileSync(
        join(dir, "package-lock.json"),
        lock({ "node_modules/root-only": { version: "1.0.0" } }),
      );
      writeFileSync(
        join(dir, "app", "package-lock.json"),
        lock({ "node_modules/in-app": { version: "2.0.0" } }),
      );
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "x");
      const r = await lockedPackagesAt(join(dir, "app"), git(dir, "rev-parse", "HEAD"));
      assert.ok(r.ok);
      assert.deepEqual([...r.packages], ["in-app@2.0.0"]);
    } finally {
      rmTemp(dir);
    }
  });

  it("is not ok, with a reason, for a commit this clone does not have", async () => {
    const { dir } = repo();
    try {
      const r = await lockedPackagesAt(dir, "0123456789abcdef0123456789abcdef01234567");
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.reason, /not in this clone/);
    } finally {
      rmTemp(dir);
    }
  });

  it("is not ok when the commit has no package-lock.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-deployed-exposure-nolock-"));
    try {
      git(dir, "init", "-q");
      writeFileSync(join(dir, "README.md"), "x");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "x");
      const r = await lockedPackagesAt(dir, git(dir, "rev-parse", "HEAD"));
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.reason, /package-lock\.json/);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses a value that is not a commit hash, so it cannot be read as a git option", async () => {
    const { dir } = repo();
    try {
      for (const bad of ["--help", "-p", "HEAD", "main", "dev", ""]) {
        const r = await lockedPackagesAt(dir, bad);
        assert.equal(r.ok, false, bad);
        assert.match(r.ok ? "" : r.reason, /commit hash/, bad);
      }
    } finally {
      rmTemp(dir);
    }
  });
});

const osvPayload = JSON.stringify({
  results: [
    {
      packages: [
        {
          package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
          vulnerabilities: [{}],
          groups: [{ max_severity: "7.5" }],
        },
        {
          package: { name: "hono", version: "4.13.7", ecosystem: "npm" },
          vulnerabilities: [{}],
          groups: [{ max_severity: "5.3" }],
        },
      ],
    },
  ],
});

describe("osvFinding exposes the affected packages", () => {
  it("lists name and version for every vulnerable package", () => {
    const r = osvFinding("osv-scanner (deps)", osvPayload);
    assert.deepEqual(r.affected, [
      { name: "lodash", version: "4.17.20" },
      { name: "hono", version: "4.13.7" },
    ]);
  });
});

describe("tagDeployed", () => {
  const row = (): SecurityCheckResult => osvFinding("osv-scanner (deps)", osvPayload);

  it("separates what is in the deployed lockfile from what is only on the branch", () => {
    const [tagged] = tagDeployed([row()], {
      ok: true,
      commit: "34d0351be5a77c051bab3e7684e75aa55dcb39f0",
      packages: new Set(["lodash@4.17.20"]),
    });
    assert.match(tagged.detail, /deployed \(34d0351\): lodash 4\.17\.20/);
    assert.match(tagged.detail, /branch only: hono 4\.13\.7/);
  });

  it("says the deployed state is unverified, with the reason, instead of guessing", () => {
    const [tagged] = tagDeployed([row()], { ok: false, reason: "the commit is not in this clone" });
    assert.match(tagged.detail, /deployed: unverified \(the commit is not in this clone\)/);
    assert.doesNotMatch(tagged.detail, /branch only/);
  });

  it("leaves rows without affected packages untouched", () => {
    const plain: SecurityCheckResult = {
      category: "secrets",
      name: "x",
      status: "pass",
      detail: "ok",
    };
    assert.deepEqual(tagDeployed([plain], { ok: false, reason: "r" }), [plain]);
  });

  it("does not change the severity or the status of a row", () => {
    const before = row();
    const [after] = tagDeployed([row()], { ok: true, commit: "a".repeat(40), packages: new Set() });
    assert.equal(after.severity, before.severity);
    assert.equal(after.status, before.status);
  });
});

async function withService(body: unknown, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

const config = (url: string): kitConfig =>
  ({ deploy: { health: { production: { url } } } }) as unknown as kitConfig;
const row = (): SecurityCheckResult[] => [osvFinding("osv-scanner (deps)", osvPayload)];

describe("tagWithDeployed reads the commit from the service and the lockfile from git", () => {
  it("tags against the commit the service reports, not the checked-out one", async () => {
    const { dir, a } = repo(); // A has lodash 4.17.20 (vulnerable), HEAD is B (4.17.21)
    try {
      await withService({ version: a }, async (url) => {
        const [tagged] = await tagWithDeployed(row(), config(url), dir, true, {
          allowLoopback: true,
          airGap: false,
        });
        assert.match(tagged.detail, /deployed \(.{7}\): lodash 4\.17\.20/);
        assert.match(tagged.detail, /branch only: hono 4\.13\.7/);
      });
    } finally {
      rmTemp(dir);
    }
  });

  it("changes nothing without --online", async () => {
    const { dir, a } = repo();
    try {
      await withService({ version: a }, async (url) => {
        const before = row();
        const after = await tagWithDeployed(before, config(url), dir, false, {
          allowLoopback: true,
          airGap: false,
        });
        assert.deepEqual(after, before);
      });
    } finally {
      rmTemp(dir);
    }
  });
});

describe("tagWithDeployed when the deployed commit cannot be used", () => {
  it("says unverified when the service reports a commit this clone does not have", async () => {
    const { dir } = repo();
    try {
      await withService({ version: "0123456789abcdef0123456789abcdef01234567" }, async (url) => {
        const [tagged] = await tagWithDeployed(row(), config(url), dir, true, {
          allowLoopback: true,
          airGap: false,
        });
        assert.match(tagged.detail, /deployed: unverified \(the commit is not in this clone/);
      });
    } finally {
      rmTemp(dir);
    }
  });

  it("says unverified when the service reports dev", async () => {
    const { dir } = repo();
    try {
      await withService({ version: "dev" }, async (url) => {
        const [tagged] = await tagWithDeployed(row(), config(url), dir, true, {
          allowLoopback: true,
          airGap: false,
        });
        assert.match(tagged.detail, /deployed: unverified \(the deployed commit was not read/);
      });
    } finally {
      rmTemp(dir);
    }
  });
});
