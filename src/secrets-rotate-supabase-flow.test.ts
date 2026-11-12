import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Characterization tests for `kit secrets rotate <KEY> --via supabase-mgmt-api`
// (cmdSecretsRotateSupabaseMgmt in src/secrets-rotate-cli.ts). The Supabase plugin is
// replaced by a fake module through a Node resolve hook, so no network call happens.
// A fake `doppler` on PATH stands in for the vault. They pin every branch so the
// function can be split safely.

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
const ANSI = /\u001b\[[0-9;]*m/g;
const POSIX_ONLY = process.platform === "win32" ? "POSIX shell fixtures" : false;
const KEY = "SUPABASE_SERVICE_ROLE_KEY";

const HOOKS_SRC = `
export async function resolve(specifier, context, next) {
  if (specifier === "sandstream-kit-plugin-supabase") {
    return { url: process.env.KIT_FAKE_PLUGIN_URL, shortCircuit: true };
  }
  return next(specifier, context);
}
`;

const REGISTER_SRC = `
import { register } from "node:module";
register(process.env.KIT_FAKE_HOOKS_URL);
`;

const FAKE_PLUGIN_SRC = `
import { appendFileSync } from "node:fs";
const cfg = JSON.parse(process.env.KIT_FAKE_PLUGIN_CFG ?? "{}");
function log(name, arg) {
  appendFileSync(process.env.KIT_FAKE_CALLS, JSON.stringify({ name, arg }) + "\\n");
}
export async function previewSupabaseRotation(arg) {
  log("preview", arg);
  return cfg.preview;
}
export async function rotateSupabaseKey(arg) {
  log("rotate", arg);
  return cfg.rotate;
}
`;

const FAKE_DOPPLER = `#!/bin/sh
echo "$@" >> "$KIT_FAKE_DOPPLER_LOG"
if [ "$KIT_FAKE_DOPPLER_FAIL" = "1" ]; then
  echo "doppler exploded" >&2
  exit 1
fi
exit 0
`;

interface Fixture {
  root: string;
  project: string;
  home: string;
  bin: string;
  calls: string;
  dopplerLog: string;
  hooksUrl: string;
  registerPath: string;
  pluginUrl: string;
}

interface RunOptions {
  args: string[];
  preview?: Record<string, unknown>;
  rotate?: Record<string, unknown>;
  store?: string;
  elevated?: boolean;
  dopplerFail?: boolean;
  readOnlyPolicy?: string;
  noPlugin?: boolean;
  env?: Record<string, string>;
}

interface Result {
  status: number | null;
  out: string;
  err: string;
  calls: Array<{ name: string; arg: Record<string, unknown> }>;
  doppler: string;
}

function useFixture(): () => Fixture {
  let f: Fixture | undefined;
  before(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-rotate-sb-")));
    const project = join(root, "project");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const lib = join(root, "lib");
    for (const d of [project, home, bin, lib]) mkdirSync(d);
    execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
    writeFileSync(join(lib, "hooks.mjs"), HOOKS_SRC);
    writeFileSync(join(lib, "register.mjs"), REGISTER_SRC);
    writeFileSync(join(lib, "plugin.mjs"), FAKE_PLUGIN_SRC);
    writeFileSync(join(bin, "doppler"), FAKE_DOPPLER);
    chmodSync(join(bin, "doppler"), 0o755);
    f = {
      root,
      project,
      home,
      bin,
      calls: join(root, "calls.jsonl"),
      dopplerLog: join(root, "doppler.log"),
      hooksUrl: pathToFileURL(join(lib, "hooks.mjs")).href,
      registerPath: join(lib, "register.mjs"),
      pluginUrl: pathToFileURL(join(lib, "plugin.mjs")).href,
    };
  });
  after(() => {
    if (f) rmTemp(f.root);
  });
  return () => {
    if (!f) throw new Error("fixture not ready");
    return f;
  };
}

function run(f: Fixture, o: RunOptions): Result {
  writeFileSync(f.calls, "");
  writeFileSync(f.dopplerLog, "");
  const toml = [o.store ? `[secrets]\nstore = "${o.store}"\n` : "", o.readOnlyPolicy ?? ""].join(
    "\n",
  );
  writeFileSync(join(f.project, ".kit.toml"), toml);
  const nodeArgs = o.noPlugin ? [] : ["--import", pathToFileURL(f.registerPath).href];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: f.home,
    USERPROFILE: f.home,
    PATH: `${f.bin}${delimiter}${process.env.PATH ?? ""}`,
    KIT_NON_INTERACTIVE: "1",
    KIT_FAKE_HOOKS_URL: f.hooksUrl,
    KIT_FAKE_PLUGIN_URL: f.pluginUrl,
    KIT_FAKE_PLUGIN_CFG: JSON.stringify({ preview: o.preview, rotate: o.rotate }),
    KIT_FAKE_CALLS: f.calls,
    KIT_FAKE_DOPPLER_LOG: f.dopplerLog,
    KIT_FAKE_DOPPLER_FAIL: o.dopplerFail ? "1" : "0",
    NO_COLOR: "1",
    ...o.env,
  };
  delete env.SUPABASE_PROJECT_REF;
  delete env.KIT_ELEVATED;
  delete env.KIT_READ_ONLY;
  if (o.elevated) env.KIT_ELEVATED = "1";
  if (o.env?.SUPABASE_PROJECT_REF) env.SUPABASE_PROJECT_REF = o.env.SUPABASE_PROJECT_REF;
  const r = spawnSync(
    process.execPath,
    [...nodeArgs, CLI_PATH, "secrets", "rotate", KEY, "--via", "supabase-mgmt-api", ...o.args],
    { cwd: f.project, env, encoding: "utf8", timeout: 60_000 },
  );
  const calls = readFileSync(f.calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; arg: Record<string, unknown> });
  return {
    status: r.status,
    out: (r.stdout ?? "").replace(ANSI, ""),
    err: (r.stderr ?? "").replace(ANSI, ""),
    calls,
    doppler: readFileSync(f.dopplerLog, "utf8"),
  };
}

const SCOPED_PREVIEW = {
  ok: true,
  existingKeyCount: 3,
  keyMode: { supportsScopedKeys: true, supportsLegacyJwt: false },
  recommendedMode: "scoped-key-mint",
};
const LEGACY_PREVIEW = {
  ok: true,
  existingKeyCount: 2,
  keyMode: { supportsScopedKeys: false, supportsLegacyJwt: true },
  recommendedMode: "jwt-secret-roll",
  warning: "project still on legacy JWT",
};
const NEW_KEY = "sb_secret_0123456789abcdef";

describe("secrets rotate --via supabase-mgmt-api: argument checks", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("needs a project ref from --project or SUPABASE_PROJECT_REF", () => {
    const r = run(fx(), { args: [] });
    assert.equal(r.status, 1);
    assert.match(r.out, /kit secrets rotate --via supabase-mgmt-api/);
    assert.match(r.err, /--project <ref> required \(or set SUPABASE_PROJECT_REF\)\./);
    assert.match(r.err, /supabase\.com\/dashboard\/project/);
    assert.deepEqual(r.calls, []);
  });

  it("reads the project ref from SUPABASE_PROJECT_REF", () => {
    const r = run(fx(), {
      args: ["--dry-run"],
      preview: SCOPED_PREVIEW,
      env: { SUPABASE_PROJECT_REF: "envref" },
    });
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, [{ name: "preview", arg: { projectRef: "envref" } }]);
  });

  it("rejects an unknown --mode before it loads the plugin", () => {
    const r = run(fx(), { args: ["--project", "abc", "--mode", "bogus"] });
    assert.equal(r.status, 1);
    assert.match(r.err, /Invalid --mode "bogus"/);
    assert.deepEqual(r.calls, []);
  });

  it("fails closed when the real plugin has no access token", () => {
    const r = run(fx(), { args: ["--project", "abc"], noPlugin: true });
    // Without the resolve hook the real workspace plugin loads, and its preview call fails
    // on the missing access token. Either way no rotation runs and the exit code is 1.
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.out, /succeeded/);
  });
});

describe("secrets rotate --via supabase-mgmt-api: preview and mode", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("stops when the preview fails", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: { ok: false, error: "401 bad token" },
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ Supabase Management API: 401 bad token/);
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ["preview"],
    );
  });

  it("prints the key count, the key mode and the auto-detected mode", () => {
    const r = run(fx(), { args: ["--project", "abc", "--dry-run"], preview: SCOPED_PREVIEW });
    assert.equal(r.status, 0);
    assert.match(r.out, /PAT verified\. Project has 3 API key\(s\)\./);
    assert.match(r.out, /Key mode: scoped=true, legacy-jwt=false/);
    assert.match(r.out, /Mode: scoped-key-mint \(auto\)/);
    assert.match(r.out, /--dry-run: not rotating\. Remove flag to proceed\./);
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ["preview"],
    );
  });

  it("falls back to scoped-key-mint when the preview recommends nothing", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--dry-run"],
      preview: { ok: true, existingKeyCount: 0 },
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /Mode: scoped-key-mint \(auto\)/);
    assert.doesNotMatch(r.out, /Key mode:/);
  });

  it("shows the preview warning when the mode is auto-detected", () => {
    const r = run(fx(), { args: ["--project", "abc", "--dry-run"], preview: LEGACY_PREVIEW });
    assert.match(r.out, /⚠ project still on legacy JWT/);
    assert.match(r.out, /Mode: jwt-secret-roll \(auto\)/);
  });

  it("hides the preview warning when --mode is explicit", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--dry-run", "--mode", "jwt-secret-roll"],
      preview: LEGACY_PREVIEW,
    });
    assert.doesNotMatch(r.out, /project still on legacy JWT/);
    assert.match(r.out, /Mode: jwt-secret-roll(?! \(auto\))/);
  });

  it("warns about every token and the legacy notice for jwt-secret-roll", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--dry-run", "--mode", "jwt-secret-roll"],
      preview: SCOPED_PREVIEW,
    });
    assert.equal(r.status, 0);
    assert.match(r.err, /jwt-secret-roll invalidates EVERY existing token/);
    assert.match(r.err, /jwt-secret-roll is legacy/);
  });
});

describe("secrets rotate --via supabase-mgmt-api: legacy-JWT refusal", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("refuses scoped-key-mint on a legacy-JWT project without --force", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--mode", "scoped-key-mint"],
      preview: LEGACY_PREVIEW,
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ Refusing scoped-key-mint: project still uses legacy JWT keys\./);
    assert.match(r.err, /treated as anon by PostgREST/);
    assert.match(r.err, /Recommended: --mode signing-key-cutover/);
    assert.match(r.err, /Override with --force/);
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ["preview"],
    );
  });

  it("proceeds past the legacy-JWT refusal with --force", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--mode", "scoped-key-mint", "--force", "--dry-run"],
      preview: LEGACY_PREVIEW,
    });
    assert.equal(r.status, 0);
    assert.match(r.err, /--force set; proceeding with scoped-key-mint despite incompatibility\./);
    assert.match(r.out, /--dry-run: not rotating/);
  });

  it("does not refuse an auto-detected mode on a legacy project", () => {
    const r = run(fx(), { args: ["--project", "abc", "--dry-run"], preview: LEGACY_PREVIEW });
    assert.doesNotMatch(r.err, /Refusing scoped-key-mint/);
  });
});

describe("secrets rotate --via supabase-mgmt-api: gates", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("refuses without an elevation marker and never rotates", () => {
    const r = run(fx(), { args: ["--project", "abc"], preview: SCOPED_PREVIEW });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ No elevation marker\./);
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ["preview"],
    );
  });

  it("refuses a jwt-secret-roll without elevation", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--mode", "jwt-secret-roll"],
      preview: SCOPED_PREVIEW,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ /);
    assert.equal(r.calls.filter((c) => c.name === "rotate").length, 0);
  });

  it("refuses a rotation that [policy.agent_writes] does not list", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      elevated: true,
      readOnlyPolicy: '[policy.agent_writes]\nsupabase = ["some_other_op"]\n',
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ refused by \[policy\.agent_writes\]: /);
    assert.equal(r.calls.filter((c) => c.name === "rotate").length, 0);
  });
});

describe("secrets rotate --via supabase-mgmt-api: rotation", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("passes the project ref and mode to the plugin", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      elevated: true,
    });
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls[1], {
      name: "rotate",
      arg: { projectRef: "abc", mode: "scoped-key-mint" },
    });
  });

  it("fails with the plugin's error", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: false, error: "rate limited" },
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ rate limited/);
  });

  it("fails with a default message when the plugin gives no error text", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: false },
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ rotation failed/);
  });

  it("fails when a successful response holds no key", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: {} },
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /Rotation completed but no key was returned/);
  });
});

describe("secrets rotate --via supabase-mgmt-api: vault output", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("prints the new value once when no vault is configured", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      elevated: true,
    });
    assert.equal(r.status, 0);
    assert.match(
      r.out,
      new RegExp(`scoped-key-mint succeeded\\.\\s+new value is ${NEW_KEY.length} chars`),
    );
    assert.match(r.err, /No upstream vault configured\. New value printed once below/);
    assert.ok(r.out.split("\n").includes(NEW_KEY));
  });

  it("treats store = env as no vault", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      store: "env",
      elevated: true,
    });
    assert.equal(r.status, 0);
    assert.ok(r.out.split("\n").includes(NEW_KEY));
  });
});

describe("secrets rotate --via supabase-mgmt-api: vault write", { skip: POSIX_ONLY }, () => {
  const fx = useFixture();

  it("uses newJwtSecret when the plugin returns no newKey", () => {
    const r = run(fx(), {
      args: ["--project", "abc", "--mode", "jwt-secret-roll"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newJwtSecret: "jwt-secret-value-1234" } },
      elevated: true,
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /jwt-secret-roll succeeded/);
    assert.ok(r.out.split("\n").includes("jwt-secret-value-1234"));
    assert.deepEqual(r.calls[1], {
      name: "rotate",
      arg: { projectRef: "abc", mode: "jwt-secret-roll" },
    });
  });

  it("writes the new value to the vault and points to --propagate", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      store: "doppler",
      elevated: true,
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /✓ wrote to vault \(doppler\)/);
    assert.match(r.out, /Next: re-run with --propagate vercel,github/);
    assert.equal(r.doppler.trim(), `secrets set ${KEY}=${NEW_KEY}`);
    assert.ok(!r.out.includes(NEW_KEY));
  });

  it("prints the new value when the vault write fails", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      store: "doppler",
      dopplerFail: true,
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /✗ vault write failed: /);
    assert.match(r.err, /New value \(copy now/);
    assert.ok(r.err.includes(NEW_KEY));
  });

  it("reports a store with no write support as a failed write", () => {
    const r = run(fx(), {
      args: ["--project", "abc"],
      preview: SCOPED_PREVIEW,
      rotate: { ok: true, result: { newKey: NEW_KEY } },
      store: "bitwarden",
      elevated: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.err, /vault write failed: migration to 'bitwarden' not yet supported/);
  });
});
