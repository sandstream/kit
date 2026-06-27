import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKitWrapper,
  wrapperPathDirs,
  ensureKitWrapper,
  kitWrapperPath,
  WRAPPER_MARKER,
  type WrapperSpec,
} from "./kit-wrapper.js";

const SPEC: WrapperSpec = {
  nodePath: "/opt/node22/bin/node",
  cliPath: "/usr/lib/kit/dist/cli.js",
  miseShimsDir: "/home/agent/.local/share/mise/shims",
  npmGlobalBin: "/home/agent/.npm-global/bin",
};

describe("generateKitWrapper", () => {
  it("emits POSIX sh with marker, PATH activation, and an absolute exec line", () => {
    const script = generateKitWrapper(SPEC);
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.ok(script.includes(WRAPPER_MARKER));
    assert.ok(
      script.includes(
        'export PATH="/home/agent/.local/share/mise/shims:/home/agent/.npm-global/bin:$PATH"',
      ),
      "prepends mise shims + npm global bin",
    );
    assert.ok(
      script.includes('exec "/opt/node22/bin/node" "/usr/lib/kit/dist/cli.js" "$@"'),
      "exec's the real kit by absolute node + cli.js",
    );
  });

  it("omits the mise shims dir when mise is absent", () => {
    const script = generateKitWrapper({ ...SPEC, miseShimsDir: undefined });
    assert.ok(!script.includes("mise/shims"));
    assert.ok(script.includes('export PATH="/home/agent/.npm-global/bin:$PATH"'));
  });

  it("the assembled PATH resolves kit even from a non-login shell PATH", () => {
    // Simulate the stripped PATH a container/CI hook shell sees: it has neither
    // the mise shims nor the npm global bin, so a bare `kit` would not resolve.
    const nonLoginPath = "/usr/bin:/bin";
    assert.ok(
      !nonLoginPath.split(":").includes(SPEC.npmGlobalBin!),
      "precondition: npm global bin is NOT on the non-login PATH",
    );
    // The wrapper prepends its dirs ahead of the inherited PATH.
    const effective = [...wrapperPathDirs(SPEC), ...nonLoginPath.split(":")];
    assert.ok(
      effective.includes(SPEC.npmGlobalBin!),
      "wrapper PATH now contains the dir a global `kit` install lives in",
    );
    assert.ok(effective.includes(SPEC.miseShimsDir!), "and the mise shims dir");
  });
});

describe("ensureKitWrapper", () => {
  it("writes a 0755 managed wrapper, then is idempotent", () => {
    const home = mkdtempSync(join(tmpdir(), "kit-wrap-"));
    try {
      const r1 = ensureKitWrapper({
        home,
        nodePath: SPEC.nodePath,
        cliPath: SPEC.cliPath,
        miseShimsDir: SPEC.miseShimsDir,
        npmGlobalBin: SPEC.npmGlobalBin,
      });
      assert.equal(r1.action, "written");
      assert.equal(r1.path, kitWrapperPath(home));
      const mode = statSync(r1.path).mode & 0o777;
      assert.equal(mode, 0o755);
      assert.ok(readFileSync(r1.path, "utf-8").includes(WRAPPER_MARKER));

      const r2 = ensureKitWrapper({
        home,
        nodePath: SPEC.nodePath,
        cliPath: SPEC.cliPath,
        miseShimsDir: SPEC.miseShimsDir,
        npmGlobalBin: SPEC.npmGlobalBin,
      });
      assert.equal(r2.action, "unchanged");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("updates when the resolved node/cli path changes", () => {
    const home = mkdtempSync(join(tmpdir(), "kit-wrap-"));
    try {
      ensureKitWrapper({ home, nodePath: SPEC.nodePath, cliPath: SPEC.cliPath });
      const r = ensureKitWrapper({ home, nodePath: "/new/node", cliPath: SPEC.cliPath });
      assert.equal(r.action, "updated");
      assert.ok(readFileSync(r.path, "utf-8").includes('exec "/new/node"'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never clobbers an unmanaged ~/.kit/bin/kit", () => {
    const home = mkdtempSync(join(tmpdir(), "kit-wrap-"));
    try {
      const path = kitWrapperPath(home);
      mkdirSync(join(home, ".kit", "bin"), { recursive: true });
      const userOwn = "#!/bin/sh\necho 'my own kit shim'\n";
      writeFileSync(path, userOwn);
      const r = ensureKitWrapper({ home, nodePath: SPEC.nodePath, cliPath: SPEC.cliPath });
      assert.equal(r.action, "unmanaged");
      assert.equal(readFileSync(path, "utf-8"), userOwn, "user's file is untouched");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips cleanly when the cli.js path cannot be resolved", () => {
    const home = mkdtempSync(join(tmpdir(), "kit-wrap-"));
    const prevArgv = process.argv[1];
    try {
      // @ts-expect-error simulate a runtime with no resolvable entrypoint
      process.argv[1] = undefined;
      const r = ensureKitWrapper({ home, cliPath: undefined });
      assert.equal(r.action, "skipped");
    } finally {
      process.argv[1] = prevArgv;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
