import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { checkGuardDog, gateStatus } from "./check-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

async function withFixture(run: (root: string, cache: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "kit-guarddog-"));
  const cache = join(root, "legacy-cache.json");
  const env = {
    PATH: join(root, "bin") + ":/usr/bin:/bin",
    KIT_GUARDDOG: "1",
    KIT_GUARDDOG_CACHE: cache,
    KIT_GUARDDOG_TIMEOUT_MS: "10000",
    GUARDDOG_NPM_INCLUDE_DEV_DEPENDENCIES: "false",
  };
  const previous = Object.entries(env).map(([key]) => [key, process.env[key]] as const);
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin", "guarddog"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" "$GUARDDOG_NPM_INCLUDE_DEV_DEPENDENCIES" >> invocations',
        "/bin/cat report.json",
      ].join("\n"),
      { mode: 0o755 },
    );
    Object.assign(process.env, env);
    await run(root, cache);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmTemp(root);
  }
}

const windows = { skip: process.platform === "win32" };

it("GuardDog reports malformed manifests through the strict gate", windows, async () => {
  await withFixture(async (root) => {
    writeFileSync(join(root, "package.json"), "{invalid");
    process.env.KIT_GUARDDOG = "0";
    assert.equal((await checkGuardDog(root)).status, "skip");
    writeFileSync(join(root, ".kit.toml"), "version = 1\n[scan]\nguarddog = true\n");
    const r = await checkGuardDog(root);
    assert.equal(r.status, "warn");
    assert.equal(r.evidenceStatus, "malformed");
    assert.equal(r.didNotRun, true);
    assert.equal(gateStatus(r), "fail");
    assert.equal(gateStatus(r, { lenient: true }), "warn");
    assert.equal(existsSync(join(root, "invocations")), false);
  });
});

it(
  "GuardDog ignores an otherwise matching legacy cache and rescans after a clean result",
  windows,
  async () => {
    await withFixture(async (root, cache) => {
      writeFileSync(join(root, "package.json"), '{"devDependencies":{"fixture":"1.0.0"}}');
      writeFileSync(join(root, "requirements.txt"), "not-selected==1\n");
      const legacy = JSON.stringify({
        depsHash: createHash("sha256").update("fixture@1.0.0").digest("hex"),
        scannedAt: new Date().toISOString(),
        packages: 1,
      });
      writeFileSync(cache, legacy);
      writeFileSync(
        join(root, "report.json"),
        JSON.stringify([
          {
            dependency: "fixture",
            version: "1.0.0",
            result: { issues: 0, errors: {}, results: {} },
          },
        ]),
      );

      assert.equal((await checkGuardDog(root)).status, "pass");
      writeFileSync(join(root, "report.json"), "[]");
      const second = await checkGuardDog(root);
      assert.equal(second.status, "warn");
      assert.equal(second.evidenceStatus, "missing");
      assert.equal(gateStatus(second), "fail");
      const invocation = ["npm", "verify", "package.json", "--output-format=json", "true", ""].join(
        "\n",
      );
      assert.equal(readFileSync(join(root, "invocations"), "utf8"), invocation.repeat(2));
      assert.equal(readFileSync(cache, "utf8"), legacy);
    });
  },
);

it("GuardDog skips an absent target and verifies an empty PyPI target", windows, async () => {
  await withFixture(async (root, cache) => {
    assert.equal((await checkGuardDog(root)).status, "skip");
    writeFileSync(join(root, "requirements.txt"), "# no requirements\n");
    writeFileSync(join(root, "report.json"), "[]");
    const r = await checkGuardDog(root);
    assert.equal(r.status, "pass");
    assert.equal(r.evidenceStatus, "complete-empty");
    assert.match(
      readFileSync(join(root, "invocations"), "utf8"),
      /^pypi\nverify\nrequirements\.txt\n/,
    );
    assert.equal(existsSync(cache), false);
  });
});
