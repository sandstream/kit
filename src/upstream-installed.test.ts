import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { resolveInstalledVersion } from "./upstream-installed.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function inTempDir(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-installed-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      const full = join(dir, file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    body(dir);
  } finally {
    rmTemp(dir);
  }
}

const PKG = JSON.stringify({ dependencies: { convex: "^1.45.0" } });

describe("lockfiles come first", () => {
  it("reads package-lock.json (lockfileVersion 3)", () =>
    inTempDir(
      {
        "package.json": PKG,
        "package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "": {}, "node_modules/convex": { version: "1.45.2" } },
        }),
      },
      (dir) => {
        const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
        assert.equal(got.version, "1.45.2");
        assert.equal(got.source, "package-lock.json");
        assert.equal(got.range, "^1.45.0");
      },
    ));

  it("reads package-lock.json (lockfileVersion 1, dependencies map)", () =>
    inTempDir(
      {
        "package.json": PKG,
        "package-lock.json": JSON.stringify({
          lockfileVersion: 1,
          dependencies: { convex: { version: "1.44.9" } },
        }),
      },
      (dir) => {
        assert.equal(
          resolveInstalledVersion(dir, "package.json", "convex", "^1").version,
          "1.44.9",
        );
      },
    ));

  it("reads bun.lock, which allows comments and trailing commas", () =>
    inTempDir(
      {
        "package.json": PKG,
        "bun.lock": `{
  // bun text lockfile
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "x", "dependencies": { "convex": "^1.45.0", }, }, },
  "packages": {
    "convex": ["convex@1.45.1", "", { "dependencies": {} }, "sha512-abc"],
    "@workos-inc/node": ["@workos-inc/node@7.2.0", "", {}, "sha512-def"],
  },
}
`,
      },
      (dir) => {
        const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
        assert.equal(got.version, "1.45.1");
        assert.equal(got.source, "bun.lock");
        assert.equal(
          resolveInstalledVersion(dir, "package.json", "@workos-inc/node", "^7").version,
          "7.2.0",
        );
      },
    ));
});

const PNPM = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      convex:
        specifier: ^1.45.0
        version: 1.45.3(react@19.0.0)

  web:
    dependencies:
      convex:
        specifier: ^1.44.0
        version: 1.44.4
      '@workos-inc/node':
        specifier: ^7.0.0
        version: 7.1.0

packages:

  convex@1.45.3:
    resolution: {integrity: sha512-x}
`;

describe("pnpm lockfiles and parent folders", () => {
  it("reads pnpm-lock.yaml for the root importer and strips the peer suffix", () =>
    inTempDir({ "package.json": PKG, "pnpm-lock.yaml": PNPM }, (dir) => {
      const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
      assert.equal(got.version, "1.45.3");
      assert.equal(got.source, "pnpm-lock.yaml");
    }));

  it("reads the pnpm importer that matches the manifest folder", () =>
    inTempDir({ "web/package.json": PKG, "pnpm-lock.yaml": PNPM }, (dir) => {
      assert.equal(
        resolveInstalledVersion(dir, "web/package.json", "convex", "^1.44.0").version,
        "1.44.4",
      );
      assert.equal(
        resolveInstalledVersion(dir, "web/package.json", "@workos-inc/node", "^7").version,
        "7.1.0",
      );
    }));

  it("finds a lockfile in a parent folder for a workspace package", () =>
    inTempDir(
      {
        "package.json": "{}",
        "packages/app/package.json": PKG,
        "package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "node_modules/convex": { version: "1.45.9" } },
        }),
      },
      (dir) => {
        const got = resolveInstalledVersion(dir, "packages/app/package.json", "convex", "^1.45.0");
        assert.equal(got.version, "1.45.9");
      },
    ));
});

describe("fallback to the declared range", () => {
  it("uses the lower bound of a caret range and says it is an estimate", () =>
    inTempDir({ "package.json": PKG }, (dir) => {
      const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
      assert.equal(got.version, "1.45.0");
      assert.equal(got.source, "declared-range");
    }));

  it("handles tilde, >=, and an exact version", () =>
    inTempDir({ "package.json": PKG }, (dir) => {
      for (const [range, want] of [
        ["~2.3.4", "2.3.4"],
        [">=3.0.1", "3.0.1"],
        ["4.5.6", "4.5.6"],
      ]) {
        assert.equal(resolveInstalledVersion(dir, "package.json", "x", range).version, want);
      }
    }));

  it("falls back when the lockfile does not list the package", () =>
    inTempDir(
      {
        "package.json": PKG,
        "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
      },
      (dir) => {
        const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
        assert.equal(got.source, "declared-range");
      },
    ));

  it("falls back and notes a lockfile it cannot parse", () =>
    inTempDir({ "package.json": PKG, "package-lock.json": "{ nope" }, (dir) => {
      const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
      assert.equal(got.source, "declared-range");
      assert.match(got.note ?? "", /package-lock\.json/);
    }));

  it("reports a binary bun.lockb as unsupported instead of guessing", () =>
    inTempDir({ "package.json": PKG, "bun.lockb": "\u0000binary" }, (dir) => {
      const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
      assert.equal(got.source, "declared-range");
      assert.match(got.note ?? "", /bun\.lockb/);
    }));

  it("returns no version for ranges that name no version", () =>
    inTempDir({ "package.json": PKG }, (dir) => {
      for (const range of ["latest", "*", "workspace:*", "github:o/r", "file:../x", ""]) {
        const got = resolveInstalledVersion(dir, "package.json", "convex", range);
        assert.equal(got.version, null, range);
        assert.equal(got.source, "unresolved", range);
      }
    }));
});

describe("untrusted repository content", () => {
  it("refuses a symlinked lockfile and never echoes the file it points at", () =>
    inTempDir({ "package.json": PKG, "outside/secret.txt": "TOP-SECRET-VALUE" }, (dir) => {
      symlinkSync(join(dir, "outside", "secret.txt"), join(dir, "package-lock.json"));
      const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
      assert.equal(got.source, "declared-range");
      assert.match(got.note ?? "", /package-lock\.json is a symlink/);
      assert.ok(!JSON.stringify(got).includes("TOP-SECRET-VALUE"));
    }));

  it("reports a broken lockfile with a fixed message, not the parser's excerpt", () =>
    inTempDir(
      { "package.json": PKG, "package-lock.json": '{ "token": "TOP-SECRET-VALUE" nope' },
      (dir) => {
        const got = resolveInstalledVersion(dir, "package.json", "convex", "^1.45.0");
        assert.match(got.note ?? "", /package-lock\.json could not be parsed/);
        assert.ok(!JSON.stringify(got).includes("TOP-SECRET-VALUE"));
      },
    ));
});
