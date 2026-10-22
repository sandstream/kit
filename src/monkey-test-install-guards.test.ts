import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareTrees,
  installRunsRepoCode,
  packageManagerRefusal,
  PLAIN_SEMVER,
  verifyAgainstRegistry,
} from "./monkey-test-install-guards.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-install-guards-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

function tree(name: string, files: Record<string, string>): string {
  const root = join(dir, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

describe("compareTrees", () => {
  const reference = { "cli.js": "a", "lib/x.js": "b" };

  it("is empty for identical trees", () => {
    assert.deepEqual(compareTrees(tree("i", reference), tree("r", reference)), []);
  });

  it("reports a modified, a missing and an extra file", () => {
    const installed = tree("i", { "cli.js": "TAMPERED", "extra.js": "c" });
    assert.deepEqual(compareTrees(installed, tree("r", reference)).sort(), [
      "extra: extra.js",
      "missing: lib/x.js",
      "modified: cli.js",
    ]);
  });
});

describe("packageManagerRefusal", () => {
  it("accepts plain forms and an absent field", () => {
    for (const value of [undefined, "npm", "pnpm@9.0.0", "yarn@4.1.0+sha512.abcdef0123"]) {
      assert.equal(packageManagerRefusal({ packageManager: value }), null, String(value));
    }
  });

  it("refuses a URL or a range", () => {
    for (const value of ["yarn@https://example.test/y.js", "pnpm@^9", "npm@latest"]) {
      assert.match(packageManagerRefusal({ packageManager: value }) ?? "", /not a plain/, value);
    }
  });
});

describe("installRunsRepoCode", () => {
  it("is null for a plain project", () => {
    assert.equal(installRunsRepoCode(dir), null);
  });

  it("flags yarn plugins, a pnpm hook setting in .npmrc and in the workspace file", () => {
    writeFileSync(join(dir, ".yarnrc.yml"), "plugins:\n  - path: x.cjs\n");
    assert.match(installRunsRepoCode(dir) ?? "", /yarn plugins/);
    rmSync(join(dir, ".yarnrc.yml"));
    writeFileSync(join(dir, ".npmrc"), "global-pnpmfile=./hook.cjs\n");
    assert.match(installRunsRepoCode(dir) ?? "", /\.npmrc sets a pnpm hook file/);
    rmSync(join(dir, ".npmrc"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "pnpmfile: ./hook.cjs\n");
    assert.match(installRunsRepoCode(dir) ?? "", /pnpm-workspace\.yaml/);
  });
});

describe("version check before the registry download", () => {
  it("accepts a plain semver and rejects a range, tag, URL or git spec", () => {
    for (const ok of ["1.55.0", "1.56.0-alpha.1", "1.0.0+build.5"])
      assert.ok(PLAIN_SEMVER.test(ok), ok);
    for (const bad of [
      "^1.55.0",
      "latest",
      "https://example.test/x.tgz",
      "git+https://example.test/x",
      "1.55",
      "file:../x",
    ]) {
      assert.equal(PLAIN_SEMVER.test(bad), false, bad);
    }
  });

  it("refuses a non-semver version without touching the network", async () => {
    const result = await verifyAgainstRegistry(
      "playwright",
      dir,
      "git+https://example.test/evil.git",
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /not one kit can check/);
  });

  it("refuses a package name outside the three kit checks", async () => {
    const result = await verifyAgainstRegistry("evil-package", dir, "1.0.0");
    assert.equal(result.ok, false);
  });
});
