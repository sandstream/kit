/**
 * Use-time enforcement of the vendor-CLI pin beyond the vault reads (kit-research#232): `eas`,
 * `dotenvx`, the `vercel` and `supabase` adapters, the Infisical login probe, `kit secrets
 * propagate` (every target goes through `spawnWithStdin`), the `vercel env ls` deploy check, and
 * service auth checks. For each: a tampered stub is refused, the stub never runs, and it runs
 * again after `kit tools pin --accept`. Fake CLIs only.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pinOne } from "./commands/tools-pin.js";
import { BACKENDS, resolveViaBackend } from "./secret-backends.js";
import { checkSecrets } from "./check-secrets.js";
import { checkInfisicalStatus } from "./infisical-status.js";
import { PIN_REFUSED_CODE, spawnWithStdin } from "./secrets-propagate-exec.js";
import { checkDeploy } from "./check-deploy.js";
import { checkServices } from "./check-services.js";
import { vercelHostingAdapter } from "./adapters/vercel-hosting.js";
import { supabaseDbAdapter } from "./adapters/supabase-db.js";
import { expoEasAdapter } from "./adapters/expo-eas.js";
import type { AdapterContext } from "./adapters/types.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "./vendor-cli-pin.test-support.js";

interface Case {
  tool: string;
  what: string;
  run: (f: Fixture) => Promise<unknown>;
  /** A line the stub logs once the call is allowed to run. */
  ran: RegExp;
}

const ctx = (f: Fixture, existingEnv: Record<string, string> = {}) =>
  ({ projectPath: f.proj, existingEnv, config: {} }) as unknown as AdapterContext;

const CASES: Case[] = [
  {
    tool: "eas",
    what: "the eas secret backend",
    run: () => resolveViaBackend("K", { source: "eas", name: "K" }),
    ran: /^secret:list --json$/m,
  },
  {
    tool: "eas",
    what: "checkSecrets' eas probe",
    run: (f) => checkSecrets({ keys: { K: { source: "eas", name: "K" } } }, f.proj),
    ran: /^secret:list --json$/m,
  },
  {
    tool: "eas",
    what: "the expo/eas adapter",
    run: (f) => expoEasAdapter.check(ctx(f, { EXPO_TOKEN: "t" })),
    ran: /^whoami$/m,
  },
  {
    tool: "dotenvx",
    what: "the dotenvx backend read",
    run: (f) => resolveViaBackend("K", { source: "dotenvx", name: "K" }, undefined, f.proj),
    ran: /^get K$/m,
  },
  {
    tool: "dotenvx",
    what: "the dotenvx backend write",
    run: () => BACKENDS.dotenvx!.write!("K", "v", {}).catch(() => undefined),
    ran: /^set K v$/m,
  },
  {
    tool: "vercel",
    what: "the vercel/hosting adapter",
    run: (f) => vercelHostingAdapter.provision(ctx(f)),
    ran: /^--version$/m,
  },
  {
    tool: "supabase",
    what: "the supabase/db adapter",
    run: (f) => supabaseDbAdapter.check(ctx(f)),
    ran: /^status$/m,
  },
  {
    tool: "infisical",
    what: "the Infisical login probe",
    run: (f) =>
      checkInfisicalStatus({
        cwd: f.proj,
        env: { ...process.env, INFISICAL_DOMAIN: "https://app.infisical.com" },
      }),
    ran: /^login status --json/m,
  },
  {
    tool: "wrangler",
    what: "secrets propagate (spawnWithStdin)",
    run: () => spawnWithStdin("wrangler", ["secret", "put", "K"], "v"),
    ran: /^secret put K$/m,
  },
  {
    tool: "supabase",
    what: "secrets propagate to supabase (spawnWithStdin)",
    run: () => spawnWithStdin("supabase", ["secrets", "set"], ""),
    ran: /^secrets set$/m,
  },
  {
    tool: "vercel",
    what: "the deploy check's `vercel env ls`",
    run: (f) =>
      checkDeploy({ vercel: { environments: { production: { project: "p" } } } } as never, f.proj, {
        airGap: true,
      }),
    ran: /^env ls production/m,
  },
  {
    tool: "vercel",
    what: "a service auth check (`vercel whoami`)",
    run: (f) => checkServices({ v: { check: "vercel whoami" } } as never, f.proj),
    ran: /^whoami$/m,
  },
];

describe("vendor-CLI pin at use time on deploy and credential CLIs", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  let restore: () => void;
  const cwd = process.cwd();
  const savedToken = process.env.VERCEL_TOKEN;
  const install = (tool: string) => copyFileSync(join(f.bin, "op"), join(f.bin, tool));

  beforeEach(() => {
    f = makeFixture();
    process.env.PATH = f.bin;
    delete process.env.VERCEL_TOKEN;
    process.chdir(f.proj);
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restore = () => (process.stderr.write = write);
  });

  afterEach(() => {
    restore();
    process.chdir(cwd);
    if (savedToken !== undefined) process.env.VERCEL_TOKEN = savedToken;
    f.done();
  });

  for (const c of CASES) {
    it(`${c.what}: a tampered ${c.tool} never runs; --accept re-enables it`, async () => {
      install(c.tool);
      assert.equal((await pinOne(c.tool, false, f.deps, f.io)).result, "pinned");
      f.writeOp(f.bin, opStub("2.30.0", "tampered"));
      install(c.tool);
      f.clearLog();

      await c.run(f);
      assert.equal(f.logged(), "", `the tampered ${c.tool} was executed`);
      assert.equal(process.exitCode, 1, "the refusal fails the run");

      process.exitCode = 0;
      assert.equal((await pinOne(c.tool, true, f.deps, f.io)).result, "accepted");
      await c.run(f);
      assert.match(f.logged(), c.ran);
    });
  }

  it("spawnWithStdin reports a refusal as its own exit code, with the reason first", async () => {
    install("gh");
    assert.equal((await pinOne("gh", false, f.deps, f.io)).result, "pinned");
    f.writeOp(f.bin, opStub("2.30.0", "tampered"));
    install("gh");
    const r = await spawnWithStdin("gh", ["secret", "set", "K"], "secret-value");
    assert.equal(r.code, PIN_REFUSED_CODE);
    assert.match(r.stderr.split("\n")[0]!, /^kit refused to run gh: its SHA-256 differs/);
    assert.doesNotMatch(r.stderr, /secret-value/);
  });
});
