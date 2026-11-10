import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { installFakeProviderClis } from "./fake-provider-cli.test-support.js";

it("provider isolation clears credentials, blocks accidental fetch, and restores local state", async () => {
  const previousToken = process.env.VERCEL_TOKEN;
  const previousFetch = globalThis.fetch;
  const previousPath = process.env.PATH;
  process.env.VERCEL_TOKEN = "synthetic-fixture-token";
  const fixture = installFakeProviderClis();
  try {
    assert.equal(process.env.VERCEL_TOKEN, undefined);
    await assert.rejects(fetch("https://fixture.invalid"), /network is disabled/);
  } finally {
    fixture.restore();
    assert.equal(process.env.PATH, previousPath);
    assert.equal(globalThis.fetch, previousFetch);
    assert.equal(process.env.VERCEL_TOKEN, "synthetic-fixture-token");
    if (previousToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previousToken;
  }
});

const providerNames = ["vercel", "fly", "flyctl", "railway", "wrangler", "aws", "supabase", "gh"];

it(
  "both propagation suites shadow installed provider CLIs",
  {
    skip:
      process.platform === "win32"
        ? "Expected: this sentinel uses POSIX launchers. Windows executable stand-ins require a Windows runner."
        : false,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "kit-provider-sentinel-"));
    try {
      const bin = join(root, "bin");
      const log = join(root, "escaped.jsonl");
      mkdirSync(bin);
      const runner = join(root, "sentinel.cjs");
      writeFileSync(
        runner,
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.stdin.resume(); process.stdin.on('end', () => { process.exitCode = 1; });\n`,
      );
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      for (const name of providerNames) {
        const path = join(bin, name);
        writeFileSync(
          path,
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} ${quote(name)} "$@"\n`,
        );
        chmodSync(path, 0o755);
      }
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        KIT_AUDIT_ANCHOR: "0",
        KIT_MEMORY_DB: join(root, "memory.db"),
        KIT_MEMORY_DIR: join(root, "memory"),
        TSX_DISABLE_CACHE: "1",
      };
      for (const key of Object.keys(env)) {
        if (
          /^(?:VERCEL|NOW|FLY|FLYCTL|RAILWAY|CLOUDFLARE|CF|AWS|SUPABASE|GH|GITHUB)_/i.test(key) ||
          key === "NODE_OPTIONS"
        )
          delete env[key as keyof typeof env];
      }
      const probe = spawnSync("vercel", ["sentinel-check"], {
        env,
        input: "",
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(probe.status, 1);
      assert.match(readFileSync(log, "utf8"), /sentinel-check/);
      writeFileSync(log, "");
      const source = import.meta.url.endsWith(".ts");
      const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
      const tests = ["policy-gate.test", "secrets-propagate.test"].map((name) =>
        fileURLToPath(new URL(`./${name}.${source ? "ts" : "js"}`, import.meta.url)),
      );
      const child = spawnSync(process.execPath, [...loader, "--test", ...tests], {
        env,
        cwd: root,
        encoding: "utf8",
        timeout: 25_000,
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(readFileSync(log, "utf8"), "", "a test reached an installed provider sentinel");
    } finally {
      rmTemp(root);
    }
  },
);
