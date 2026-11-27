import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSecrets } from "./check-secrets.js";
import { cmdSecrets } from "./commands/secrets.js";
import { executeGovernedCommand } from "./run-governance.js";
import { groupBySecret, readSecretAuditEvents } from "./audit-secrets.js";
import { SECRET_READ_OP, secretReadEvents } from "./secrets-read-record.js";
import { governanceClient, governanceFixture } from "./governance-outcome.test-support.js";

// Fixture values only. Governance is OFF in every project below: that is the default.
const VALUES = ["fixture-not-a-secret-0001", "4821"];
const CONFIG = `[secrets]\nstore = "env"\n[secrets.keys.DEMO_DB_PASSWORD]\nsource = "config"\nvalue = "${VALUES[0]}"\n[secrets.keys.DEMO_PIN]\nsource = "config"\nvalue = "${VALUES[1]}"\n`;

const SECRETS = pathToFileURL(join(process.cwd(), "src", "secrets.ts")).href;
const TSX = import.meta.resolve("tsx");

interface LoggedEvent {
  operation: string;
  agent_name?: string;
  metadata?: Record<string, unknown>;
}

function project(t: TestContext): string {
  const { target } = governanceFixture(t);
  // The harness running this suite is not under test here (governanceFixture restores the env).
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_THREAD_ID;
  writeFileSync(join(target, ".kit.toml"), CONFIG);
  return target;
}

/** The read events, after asserting the log holds no fixture value. */
function readEvents(dir: string): LoggedEvent[] {
  const log = readFileSync(join(dir, ".kit-audit.jsonl"), "utf-8");
  for (const value of VALUES) assert.ok(!log.includes(`"${value}"`), log);
  const events = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
  return events.filter((e) => e.operation === SECRET_READ_OP);
}

describe("secret reads are recorded with [governance] off", () => {
  it("`kit secrets` records the key names, the store and the surface", async (t) => {
    const dir = project(t);
    process.chdir(dir);
    const argv = process.argv;
    t.after(() => (process.argv = argv));
    process.argv = [process.execPath, "kit", "secrets"];
    assert.equal(await cmdSecrets(), true);
    const [event, ...rest] = readEvents(dir);
    assert.equal(rest.length, 0);
    assert.deepEqual(event!.metadata, {
      names: ["DEMO_DB_PASSWORD", "DEMO_PIN"],
      store: "config",
      via: "kit secrets",
    });
    const { reports } = groupBySecret(await readSecretAuditEvents(dir));
    assert.deepEqual(reports.map((r) => r.key).sort(), ["DEMO_DB_PASSWORD", "DEMO_PIN"]);
  });

  it("the MCP kit_secrets tool records its surface", async (t) => {
    const dir = project(t);
    const client = await governanceClient(t);
    const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: dir } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(
      readEvents(dir).map((e) => e.metadata?.via),
      ["mcp kit_secrets"],
    );
  });
});

describe("secret reads by kit run and kit check are recorded; unrecordable reads are refused", () => {
  it("`kit run` records the .env.local names it hands the child", async (t) => {
    const dir = project(t);
    writeFileSync(
      join(dir, ".env.local"),
      `DEMO_PIN=${VALUES[1]}\nDEMO_DB_PASSWORD=${VALUES[0]}\n`,
    );
    const outcome = await executeGovernedCommand({
      commandArgs: [process.execPath, "-e", ""],
      cwd: dir,
      streamOutput: false,
    });
    assert.equal(outcome.ok, true, outcome.reason);
    assert.deepEqual(readEvents(dir)[0]!.metadata, {
      names: ["DEMO_PIN", "DEMO_DB_PASSWORD"],
      store: ".env.local",
      via: "kit run",
    });
  });

  it("`kit check` records the vault-backed names it probes, not env or config keys", async (t) => {
    const dir = project(t);
    // No `aws` on PATH: the probe fails, the record that it was attempted stays.
    process.env.PATH = dir;
    await checkSecrets(
      {
        store: "aws-sm",
        keys: { DEMO_VAULT: { source: "aws-sm" }, DEMO_LOCAL: { source: "env" } },
      },
      dir,
    );
    assert.deepEqual(
      readEvents(dir).map((e) => e.metadata),
      [{ name: "DEMO_VAULT", store: "aws-sm", via: "kit check" }],
    );
  });

  it("refuses the read, and writes no .env.local, when the chain cannot take the record", (t) => {
    const dir = project(t);
    writeFileSync(join(dir, ".kit-audit.jsonl"), '{"not":"a chained line"}\n');
    // A child process: a failed append also fails the process that made it (src/audit-loss.ts).
    const script = `
      const { generateSecrets } = await import(${JSON.stringify(SECRETS)});
      const keys = { DEMO_PIN: { source: "config", value: ${JSON.stringify(VALUES[1])} } };
      await generateSecrets({ store: "env", keys }, ".env.local").catch((e) => console.log(e.name));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", TSX, "--input-type=module", "-e", script],
      { cwd: dir, encoding: "utf8", timeout: 120_000, env: process.env },
    );
    assert.equal(child.stdout.trim(), "SecretReadNotRecordedError", child.stderr);
    assert.equal(existsSync(join(dir, ".env.local")), false);
    assert.match(child.stderr, /1 audit event was not recorded/);
  });
});

describe("secretReadEvents attribution", () => {
  const read = {
    keys: ["A_NAME", "B_NAME", "A_NAME"],
    storeOf: (name: string) => (name === "A_NAME" ? "aws-sm" : ".env.local"),
    via: "kit secrets" as const,
  };

  it("one event per store, names deduplicated, the declared agent stamped", () => {
    const events = secretReadEvents(read, { agent: { id: "a-1", name: "fixture-agent" } }, {});
    assert.deepEqual(
      events.map((e) => [e.agent_id, e.agent_name, e.metadata]),
      [
        ["a-1", "fixture-agent", { name: "A_NAME", store: "aws-sm", via: "kit secrets" }],
        ["a-1", "fixture-agent", { name: "B_NAME", store: ".env.local", via: "kit secrets" }],
      ],
    );
  });

  for (const [env, harness] of [
    [{ CLAUDECODE: "1" }, "Claude Code"],
    [{ CODEX_THREAD_ID: "fixture-thread" }, "Codex"],
  ] as const) {
    it(`names the ${harness} harness`, () => {
      assert.equal(secretReadEvents(read, {}, env)[0]!.metadata?.harness, harness);
    });
  }
});

describe("every vault resolve goes through a recorded read", () => {
  it("resolveViaBackend is called only where the read is recorded", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    // secrets.ts, check-secrets.ts and secrets-incident-cli.ts record their reads in bulk first.
    const allowed = [
      "secret-backends.ts",
      "secrets-read-record.ts",
      "secrets.ts",
      "check-secrets.ts",
      "secrets-incident-cli.ts",
    ];
    const callers = readdirSync(src, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /\bresolveViaBackend\(/.test(readFileSync(join(src, f), "utf-8")))
      .map((f) => f.split(/[\\/]/).pop()!);
    assert.deepEqual(
      callers.filter((f) => !allowed.includes(f)),
      [],
    );
  });
});
