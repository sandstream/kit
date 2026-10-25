import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { flagsForCommand } from "./flag-surface.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ALL_TARGETS,
  isValidSupabaseSecretName,
  parseTargets,
  propagate,
  propagationOptionsFromArgs,
  quoteEnvValue,
} from "./secrets-propagate.js";
import { POLICY_OPS } from "./policy-gate.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("supabase is a propagation target", () => {
  it("is listed, parsed and registered as a policy op", () => {
    assert.ok(ALL_TARGETS.includes("supabase"));
    assert.deepEqual(parseTargets("vercel,supabase"), ["vercel", "supabase"]);
    assert.ok(POLICY_OPS.some((o) => o.vendor === "supabase" && o.op === "env_set"));
  });
});

describe("isValidSupabaseSecretName", () => {
  it("accepts an upper-case env name", () => {
    for (const ok of ["API_KEY", "_X", "STRIPE_WEBHOOK_SECRET", "A1"])
      assert.equal(isValidSupabaseSecretName(ok), true, ok);
  });

  it("refuses the reserved SUPABASE_ prefix, other shapes, and anything that could be read as an option", () => {
    for (const bad of [
      "SUPABASE_URL",
      "supabase_x",
      "api_key",
      "1A",
      "A-B",
      "A B",
      "",
      "--env-file",
      "A=B",
      "A\n",
    ]) {
      assert.equal(isValidSupabaseSecretName(bad), false, JSON.stringify(bad));
    }
  });
});

describe("quoteEnvValue writes one value so the Supabase CLI reads back exactly it", () => {
  // Measured against a real project: single quotes are literal, double quotes expand only \n and \r.
  it("uses single quotes when the value has no single quote and no line break", () => {
    assert.equal(quoteEnvValue("plain"), "'plain'");
    assert.equal(quoteEnvValue('a"b $X \\ #c = d'), "'a\"b $X \\ #c = d'");
    assert.equal(quoteEnvValue("a\\nb"), "'a\\nb'");
    assert.equal(quoteEnvValue(""), "''");
  });

  it("uses double quotes with \\n and \\r when the value has a single quote or a line break", () => {
    assert.equal(quoteEnvValue("it's"), '"it\'s"');
    assert.equal(quoteEnvValue("l1\nl2\r"), '"l1\\nl2\\r"');
  });

  it("refuses a value that has no exact form instead of storing it changed", () => {
    assert.throws(() => quoteEnvValue('it\'s "x"'), /cannot read that back exactly/);
    assert.throws(() => quoteEnvValue("l1\n$HOME"), /cannot read that back exactly/);
    assert.throws(() => quoteEnvValue("l1\nback\\slash"), /cannot read that back exactly/);
  });

  it("refuses a value with a NUL byte, which no env file can carry", () => {
    assert.throws(() => quoteEnvValue("a\u0000b"), /NUL/);
  });
});

describe("propagationOptionsFromArgs flags", () => {
  it("every platform flag it reads is accepted by kit secrets", () => {
    const flags = [
      "--target-env",
      "--vercel-project",
      "--vercel-team",
      "--vercel-scope",
      "--supabase-project",
      "--fly-app",
      "--cf-worker",
      "--railway-service",
      "--aws-region",
      "--github-repo",
    ];
    const accepted = flagsForCommand("secrets") ?? [];
    for (const flag of flags) {
      assert.ok(accepted.includes(flag), `${flag} is read by propagate but refused by kit secrets`);
    }
  });
});

describe("propagationOptionsFromArgs", () => {
  it("reads every platform flag, including the Vercel API and Supabase ones", () => {
    const o = propagationOptionsFromArgs([
      "--target-env",
      "preview",
      "--vercel-project",
      "app",
      "--vercel-team",
      "team_1",
      "--vercel-scope",
      "s",
      "--supabase-project",
      "abcdefghijklmnopqrst",
      "--fly-app",
      "f",
    ]);
    assert.equal(o.env, "preview");
    assert.equal(o.vercelProject, "app");
    assert.equal(o.vercelTeamId, "team_1");
    assert.equal(o.vercelScope, "s");
    assert.equal(o.supabaseProject, "abcdefghijklmnopqrst");
    assert.equal(o.flyApp, "f");
  });

  it("returns an empty object when no flag is given", () => {
    assert.deepEqual(propagationOptionsFromArgs([]), {});
  });
});

let dir: string;
let log: string;
const saved: Record<string, string | undefined> = {};

/** Puts a fake `supabase` on PATH that records its argv and the env file it was given. */
function installFakeSupabase(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-fake-supabase-"));
    log = join(dir, "calls.log");
    writeFileSync(
      join(dir, "supabase"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$FAKE_LOG"',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--env-file" ]; then cat "$2" >> "$FAKE_LOG.env"; echo "$2" >> "$FAKE_LOG.path"; fi',
        "  shift",
        "done",
        '[ -n "$FAKE_STDERR" ] && echo "$FAKE_STDERR" >&2',
        'exit "${FAKE_EXIT:-0}"',
        "",
      ].join("\n"),
    );
    chmodSync(join(dir, "supabase"), 0o755);
    for (const k of ["PATH", "FAKE_LOG", "FAKE_EXIT", "FAKE_STDERR"]) saved[k] = process.env[k];
    process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
    process.env.FAKE_LOG = log;
    delete process.env.FAKE_EXIT;
    delete process.env.FAKE_STDERR;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTemp(dir);
  });
}

const SECRET = "p@ss 'w0rd' #x=y\nline2";
const run = (
  name = "API_KEY",
  value = SECRET,
  opts = { supabaseProject: "abcdefghijklmnopqrst" },
) => propagate(name, value, ["supabase"], opts);

describe("propagate --to supabase: the command", { skip: process.platform === "win32" }, () => {
  installFakeSupabase();

  it("refuses a value that has no exact env-file form, without running the CLI or echoing the value", async () => {
    const [r] = await run("API_KEY", `it's "x" $HOME`);
    assert.equal(r.ok, false);
    assert.match(r.detail, /cannot read that back exactly/);
    assert.ok(!r.detail.includes("$HOME"));
    assert.equal(existsSync(log), false);
  });

  it("runs supabase secrets set with an env file and the project ref, and never puts the value in argv", async () => {
    const [r] = await run();
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.valueInArgv, false);
    const argv = readFileSync(log, "utf8");
    assert.match(argv, /^secrets set --env-file \S+ --project-ref abcdefghijklmnopqrst\n$/);
    assert.ok(
      !argv.includes("w0rd") && !argv.includes("API_KEY"),
      "neither value nor name in argv",
    );
  });

  it('writes NAME="value" with the value escaped, so it reads back exactly', async () => {
    await run();
    assert.equal(readFileSync(`${log}.env`, "utf8"), `API_KEY=${quoteEnvValue(SECRET)}\n`);
  });
});

describe(
  "propagate --to supabase: the env file and failures",
  { skip: process.platform === "win32" },
  () => {
    installFakeSupabase();

    it("keeps the env file in a private folder and removes it afterwards, also when the CLI fails", async () => {
      process.env.FAKE_EXIT = "1";
      process.env.FAKE_STDERR = "boom";
      await run();
      const path = readFileSync(`${log}.path`, "utf8").trim();
      assert.equal(existsSync(path), false, "the env file is gone");
      assert.equal(existsSync(join(path, "..")), false, "and so is its private folder");
    });

    it("creates the env file with mode 0600 inside a 0700 folder", async () => {
      // The fake cannot stat; check the helper the adapter uses.
      const { writePrivateEnvFile } = await import("./secrets-propagate.js");
      const file = writePrivateEnvFile("A", "b");
      try {
        assert.equal(statSync(file.path).mode & 0o777, 0o600);
        assert.equal(statSync(join(file.path, "..")).mode & 0o777, 0o700);
      } finally {
        file.remove();
      }
    });

    it("reports a CLI failure with the first stderr line and without the value", async () => {
      process.env.FAKE_EXIT = "2";
      process.env.FAKE_STDERR = `Error: rejected ${SECRET.split("\n")[0]}`;
      const [r] = await run();
      assert.equal(r.ok, false);
      assert.match(r.detail, /supabase exit 2/);
      assert.ok(!r.detail.includes("w0rd"), r.detail);
    });

    it("omits --project-ref when none is given, so the linked project is used", async () => {
      await propagate("API_KEY", "v", ["supabase"], {});
      assert.match(readFileSync(log, "utf8"), /^secrets set --env-file \S+\n$/);
    });

    it("refuses a bad name or a bad project ref before it starts anything", async () => {
      for (const [name, opts] of [
        ["SUPABASE_URL", {}],
        ["bad-name", {}],
        ["API_KEY", { supabaseProject: "--evil" }],
      ] as const) {
        const [r] = await propagate(name, "v", ["supabase"], opts);
        assert.equal(r.ok, false, name);
      }
      assert.equal(existsSync(log), false, "supabase was never run");
    });
  },
);
