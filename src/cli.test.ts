/**
 * Integration tests for the kit CLI.
 *
 * Runs the compiled CLI as a subprocess in isolated temp directories.
 * Uses only env and config secret sources — no real tool installs,
 * service logins, or network calls. CI-compatible.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { FIXTURE_EMPTY } from "./cli-fixtures.test-support.js";
import { GITIGNORE_CONTENT, runCli } from "./cli-run.test-support.js";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Standard .gitignore content for temp dirs so the security check passes

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("CLI error handling", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-err-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits 1 and explains when .kit.toml is missing", async () => {
    const result = await runCli(["check"], tempDir);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.stderr.includes(".kit.toml") || result.stdout.includes(".kit.toml"),
      "should mention the missing config file",
    );
  });

  it("exits 1 for unknown command", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["not-a-real-command"], tempDir);
    assert.equal(result.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// --help never executes a command (esp. side-effectful ones)
// ---------------------------------------------------------------------------

describe("kit <command> --help", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-help-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const exists = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    );

  it("agent-config --help prints help and does NOT inject a rules block", async () => {
    const result = await runCli(["agent-config", "--help"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(/agent-config/.test(result.stdout), `expected help; got: ${result.stdout}`);
    // The side effect (writing CLAUDE.md / AGENTS.md) must not have happened.
    assert.equal(await exists(join(tempDir, "CLAUDE.md")), false, "must not create CLAUDE.md");
    assert.equal(await exists(join(tempDir, "AGENTS.md")), false, "must not create AGENTS.md");
  });

  it("status --help prints help, not the adoption checklist", async () => {
    const result = await runCli(["status", "--help"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(/status/.test(result.stdout), `expected help; got: ${result.stdout}`);
    // The checklist run uses ✓ / ○ status markers; the help line has none.
    assert.ok(!/[✓○]/.test(result.stdout), "should show help, not run the status checklist");
  });
});

// ---------------------------------------------------------------------------
// kit check
// ---------------------------------------------------------------------------

describe("kit default command", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-default-"));
    await exec("git", ["init", "-q", tempDir]);
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("runs check when invoked with no subcommand", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli([], tempDir);
    assert.equal(result.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// kit version
// ---------------------------------------------------------------------------

describe("kit version", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-version-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("kit version prints the version from package.json", async () => {
    const pkgJson = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf-8",
    );
    const expectedVersion = (JSON.parse(pkgJson) as { version: string }).version;

    const result = await runCli(["version"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), expectedVersion);
  });

  it("kit --version prints the version from package.json", async () => {
    const pkgJson = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf-8",
    );
    const expectedVersion = (JSON.parse(pkgJson) as { version: string }).version;

    const result = await runCli(["--version"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), expectedVersion);
  });
});

// ---------------------------------------------------------------------------
// kit whoami
// ---------------------------------------------------------------------------

describe("kit whoami", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-whoami-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("returns exit 0 with no governance config", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["whoami"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stdout.includes("No agent configured"),
      `expected 'No agent configured' in: ${result.stdout}`,
    );
  });

  it("shows agent name and id when governance.agent configured", async () => {
    const config = `
[governance]
enabled = true

[governance.agent]
id = "test-agent-999"
name = "Test Runner"
`;
    await writeFile(join(tempDir, ".kit.toml"), config, "utf-8");
    const result = await runCli(["whoami"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Test Runner"), `expected agent name in: ${result.stdout}`);
    assert.ok(result.stdout.includes("test-agent-999"), `expected agent id in: ${result.stdout}`);
  });

  it("--json returns structured output", async () => {
    const config = `
[governance]
enabled = true

[governance.agent]
id = "json-agent"
name = "JSON Test"
`;
    await writeFile(join(tempDir, ".kit.toml"), config, "utf-8");
    const result = await runCli(["whoami", "--json"], tempDir, { NODE_ENV: "development" });
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.stdout) as {
      agent: { id: string; name: string } | null;
      environment: string;
    };
    assert.equal(data.agent?.id, "json-agent");
    assert.equal(data.agent?.name, "JSON Test");
    assert.ok(["dev", "staging", "prod"].includes(data.environment));
  });
});

// ---------------------------------------------------------------------------
// Wired commands that were previously documented but unrouted
// ---------------------------------------------------------------------------

describe("kit env diff", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-envdiff-"));
    await writeFile(join(tempDir, ".env.local"), "A=1\nB=2\nC=3\n", "utf-8");
    await writeFile(join(tempDir, ".env.staging"), "A=1\nB=changed\nD=4\n", "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("routes and reports drift between .env.local and the target", async () => {
    const result = await runCli(["env", "diff", "--compare", "staging"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(!result.stderr.includes("Unknown subcommand"), "must be routed");
    // C only local, D only staging, B changed; values never printed
    assert.ok(result.stdout.includes("C"), "key only in local");
    assert.ok(result.stdout.includes("D"), "key only in staging");
    assert.ok(!result.stdout.includes("changed"), "raw values must not leak");
  });

  it("exits 1 with usage when --compare is missing", async () => {
    const result = await runCli(["env", "diff"], tempDir);
    assert.equal(result.exitCode, 1);
  });
});

describe("kit secrets validate", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-secval-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(tempDir, ".kit.toml"),
      `[secrets]\nstore = "env"\n\n[secrets.keys]\n_KIT_VAL_PRESENT = { source = "env" }\n_KIT_VAL_ABSENT = { source = "env" }\n`,
      "utf-8",
    );
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits non-zero and flags the missing key", async () => {
    const result = await runCli(["secrets", "validate"], tempDir, {
      _KIT_VAL_PRESENT: "set",
    });
    assert.equal(result.exitCode, 1, "missing key → non-zero");
    assert.ok(!result.stderr.includes("Unknown subcommand"), "must be routed");
    assert.ok(result.stdout.includes("_KIT_VAL_ABSENT"), "names the missing key");
  });
});

// ---------------------------------------------------------------------------
// Malformed .kit-profile.toml must fail CLOSED (denial-of-verdict guard)
// ---------------------------------------------------------------------------

describe("kit profile — malformed .kit-profile.toml fails closed", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-profile-crash-"));
    await writeFile(join(dir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits 1 with valid JSON (never an empty-stdout crash) on invalid profile TOML", async () => {
    await writeFile(join(dir, ".kit-profile.toml"), "version = = 1\n", "utf-8");
    const result = await runCli(["profile", "check", "--gate", "--json"], dir);
    assert.equal(result.exitCode, 1);
    // The fix: KIT_INVALID_PROFILE is caught like KIT_INVALID_CONFIG — a clean JSON verdict,
    // not an uncaught stack trace with empty stdout.
    assert.ok(
      result.stdout.trim().length > 0,
      `stdout must not be empty; stderr: ${result.stderr}`,
    );
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
  });

  it("does not crash `profile show --json` on a schema-invalid profile", async () => {
    await writeFile(join(dir, ".kit-profile.toml"), "version = 999999\n", "utf-8");
    const result = await runCli(["profile", "show", "--json"], dir);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.stdout.trim().length > 0,
      `stdout must not be empty; stderr: ${result.stderr}`,
    );
    assert.equal(JSON.parse(result.stdout).ok, false);
  });
});

// ---------------------------------------------------------------------------
// mcpExposedToolNames() — the CLI-owned MCP tool surface
//
// Unlike the rest of this file these are in-process unit tests: the function is
// a pure derivation over COMMAND_REGISTRY, so no subprocess is needed. Imported
// dynamically (cli.js only runs main() when it IS the process entry, see
// isCliEntry()), which keeps this block self-contained.
// ---------------------------------------------------------------------------

/** The set of verbs an agent may reach over MCP — kit's frozen public surface. */
const EXPECTED_MCP_TOOLS = [
  "kit_check",
  "kit_context",
  "kit_fix",
  "kit_init",
  "kit_map",
  "kit_memory",
  "kit_review",
  "kit_run",
  "kit_secrets",
  "kit_triage",
];

describe("mcpExposedToolNames", () => {
  it("returns exactly the frozen set of MCP-exposed tool names", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    // Pinning the literal set (not just "matches KIT_MCP_TOOLS") is the point:
    // this is the whole surface an MCP client can invoke, snapshotted in
    // contracts/public-surface.json. Flipping `mcp: true` on another verb
    // silently widens what a shell-less agent can do, and must fail here.
    assert.deepEqual(mcpExposedToolNames(), EXPECTED_MCP_TOOLS);
  });

  it("returns the names in sorted order", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    const names = mcpExposedToolNames();
    // Callers (mcp-server.test.ts's CLI = MCP drift guard) compare with
    // deepEqual against a sorted list, so order is contractual, not incidental:
    // dropping the .sort() would break the guard rather than the surface.
    assert.deepEqual(names, [...names].sort());
  });

  it("emits only kit_-prefixed names with hyphens translated to underscores", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    for (const name of mcpExposedToolNames()) {
      // MCP tool names must stay in the [a-z0-9_] shape mcpToolName() produces;
      // a leaked hyphen (e.g. "kit_supply-chain") is not a valid tool name for
      // clients that validate it, so the `-` → `_` rewrite must never regress.
      assert.match(name, /^kit_[a-z0-9_]+$/, `unexpected tool name shape: ${name}`);
      assert.ok(!name.includes("-"), `tool name must not contain a hyphen: ${name}`);
    }
  });

  it("never exposes the same tool name twice", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    const names = mcpExposedToolNames();
    // Two registry verbs differing only by `-` vs `_` would collide into one MCP
    // tool name; the duplicate is the visible symptom of that ambiguity.
    assert.equal(new Set(names).size, names.length, `duplicate names in ${names.join(", ")}`);
  });

  it("keeps harness-protocol and operator-only verbs off the MCP surface", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    const names = new Set(mcpExposedToolNames());
    // A deny that must stay a deny. The gate-*/guard-observe/statusline verbs are
    // hook protocols that read tool-call JSON on stdin, and panic/install/login/
    // config/clone/mcp are operator decisions. None may become agent-callable.
    for (const verb of [
      "gate-bash",
      "gate-egress",
      "gate-env",
      "gate-fs",
      "guard-observe",
      "statusline",
      "panic",
      "install",
      "login",
      "config",
      "clone",
      "mcp",
    ]) {
      assert.ok(
        !names.has(`kit_${verb.replace(/-/g, "_")}`),
        `${verb} must not be exposed as an MCP tool`,
      );
    }
  });

  it("only names verbs that exist in the command registry", async () => {
    const { mcpExposedToolNames, mcpToolName, COMMANDS } = await import("./cli.js");
    const derivable = new Set(Object.keys(COMMANDS).map((verb) => mcpToolName(verb)));
    for (const name of mcpExposedToolNames()) {
      // An MCP tool with no backing CLI verb would be un-dispatchable — the
      // "CLI = MCP" invariant only holds if every name round-trips to a verb.
      assert.ok(derivable.has(name), `${name} maps to no registry verb`);
    }
  });

  it("exposes no verb that is routed away from agents by COMMAND_AUDIENCE", async () => {
    const { mcpExposedToolNames, mcpToolName, COMMAND_AUDIENCE } = await import("./cli.js");
    const exposed = new Set(mcpExposedToolNames());
    for (const [verb, audience] of Object.entries(COMMAND_AUDIENCE)) {
      if (!exposed.has(mcpToolName(verb))) continue;
      // MCP is an agent surface. A "harness" verb is a stdin protocol and a
      // "human" verb is an interactive/operator surface; either being reachable
      // over MCP means the two exposure signals disagree.
      assert.ok(
        audience !== "harness" && audience !== "human",
        `MCP-exposed verb ${verb} has non-agent audience "${audience}"`,
      );
    }
  });

  it("returns a fresh array each call, so a caller cannot corrupt the surface", async () => {
    const { mcpExposedToolNames } = await import("./cli.js");
    const first = mcpExposedToolNames();
    first.push("kit_totally_bogus");
    first.sort();
    // No memoised array behind the function: a caller that sorts/mutates the
    // result (the drift guards do exactly that) must not poison later callers.
    assert.deepEqual(mcpExposedToolNames(), EXPECTED_MCP_TOOLS);
  });
});

// ---------------------------------------------------------------------------
// Global flags: dispatch position + typo rejection
// ---------------------------------------------------------------------------

describe("global flags before the command word", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-globalflags-"));
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("`kit --read-only check` runs the check instead of 'Unknown command'", async () => {
    // README.md and docs/THREAT_MODEL.md both document this exact form. It used to
    // activate read-only mode and then refuse to dispatch, because `--read-only`
    // WAS args[0] — kit rejected its own documented security-control invocation.
    const result = await runCli(["--read-only", "check"], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!output.includes("Unknown command"), `kit refused to dispatch:\n${output}`);
    assert.ok(output.includes("read-only mode active"), "read-only mode should still activate");
  });

  it("`kit check --read-only` is not rejected as an unknown flag", async () => {
    const result = await runCli(["check", "--read-only"], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!output.includes("unknown flag"), `global flag rejected:\n${output}`);
  });

  it("`kit check --non-interactive` is not rejected as an unknown flag", async () => {
    const result = await runCli(["check", "--non-interactive"], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!output.includes("unknown flag"), `global flag rejected:\n${output}`);
  });

  it("a genuinely unknown flag is still rejected", async () => {
    const result = await runCli(["check", "--not-a-real-flag"], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.exitCode, 1);
    assert.ok(output.includes("unknown flag"), "the rejection must survive the widened allowlist");
  });
});

describe("kit upgrade rejects a typo'd flag instead of doing something else", () => {
  let tempDir: string;
  const LOCK = `{
  "tools": {
    "node": { "version": "22", "source": "mise", "installedAt": "2020-01-01T00:00:00.000Z" }
  }
}
`;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-upgradeflag-"));
    await writeFile(join(tempDir, ".kit.toml"), '[tools]\nnode = "22"\n', "utf-8");
    await mkdir(join(tempDir, ".kit"), { recursive: true });
    await writeFile(join(tempDir, ".kit", "cli-lock.json"), LOCK, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("`--self.` exits 1 and never touches the lock file", async () => {
    // The reported failure: a trailing period missed hasFlag's exact match, so the
    // self-upgrade silently became the lock-file path — it rewrote every
    // installedAt to "now", installed nothing, and printed a success line.
    const result = await runCli(["upgrade", "--self."], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.exitCode, 1, `expected rejection, got:\n${output}`);
    assert.ok(output.includes("unknown flag"), `no rejection printed:\n${output}`);
    const lock = await readFile(join(tempDir, ".kit", "cli-lock.json"), "utf-8");
    assert.ok(
      lock.includes("2020-01-01T00:00:00.000Z"),
      "a rejected invocation must not rewrite installedAt",
    );
  });

  it("plain `kit upgrade` still updates the lock files", async () => {
    const result = await runCli(["upgrade"], tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(output.includes("Updated lock files"), `the happy path regressed:\n${output}`);
  });
});
