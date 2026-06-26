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

const exec = promisify(execFile);

// Resolve CLI path relative to this compiled test file
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the kit CLI in a given directory, capturing output and exit code.
 */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        // Disable governance to avoid budget state side-effects
        ...env,
      },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Standard .gitignore content for temp dirs so the security check passes
const GITIGNORE_CONTENT = `.env
.env.local
.env.*.local
`;

const FIXTURE_EMPTY = `# Minimal kit config — no tools, services, or secrets
`;

const FIXTURE_CONFIG_SECRET = `# Config with config-sourced secrets (always available, no CLI deps)
[secrets]
store = "env"

[secrets.keys]
APP_NAME = { source = "config", value = "my-app" }
APP_ENV = { source = "config", value = "test" }
`;

const FIXTURE_ENV_SECRET = `# Config with env-sourced secret
[secrets]
store = "env"

[secrets.keys]
_KIT_INTEG_SECRET = { source = "env" }
`;

const FIXTURE_MISSING_ENV_SECRET = `# Config requiring env var that is not set
[secrets]
store = "env"

[secrets.keys]
_KIT_DEFINITELY_ABSENT_XYZ = { source = "env" }
`;

const FIXTURE_NODE_TOOL = `# Config requiring node at latest (always installed in CI)
[tools]
node = "latest"
`;

const FIXTURE_FULL_PIPELINE = `# Full pipeline fixture: config secrets + node tool
[tools]
node = "latest"

[secrets]
store = "env"

[secrets.keys]
BUILD_TARGET = { source = "config", value = "production" }
`;

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
    await rm(tempDir, { recursive: true, force: true });
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
    await rm(tempDir, { recursive: true, force: true });
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

describe("kit check", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-check-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exits 0 with empty config (no tools/services/secrets configured)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["check"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 0 when all secrets use config source (always available)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 0 when env secrets are present", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_ENV_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir, {
      _KIT_INTEG_SECRET: "test-value",
    });
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 1 when a required env secret is missing", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_MISSING_ENV_SECRET, "utf-8");
    await runCli(["check"], tempDir, {
      // Ensure the var is absent
      _KIT_DEFINITELY_ABSENT_XYZ: "",
    });
    // Either 0 or 1 depending on how env treats empty string;
    // with no value set at all, it should definitely fail
    const result2 = await runCli(["check"], tempDir);
    // _KIT_DEFINITELY_ABSENT_XYZ should not be in the environment
    assert.equal(result2.exitCode, 1);
  });

  it("produces output listing checked items", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir);
    // Should show some output (tables, status indicators)
    assert.ok(result.stdout.length > 0, "should produce non-empty output");
  });

  it("exits 0 with node at latest (always installed)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_NODE_TOOL, "utf-8");
    // Initialize lock files first so the lock check doesn't fail
    await runCli(["fix"], tempDir);
    const result = await runCli(["check"], tempDir);
    // node is always installed; "latest" always satisfies
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// kit fix
// ---------------------------------------------------------------------------

describe("kit fix", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-fix-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exits 0 when there is nothing to fix (empty config)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["fix"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("generates missing lock files automatically", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_FULL_PIPELINE, "utf-8");

    // Lock files should not exist yet
    const lockDir = join(tempDir, ".kit");
    let lockExisted = false;
    try {
      await access(join(lockDir, "skills-lock.json"));
      lockExisted = true;
    } catch {
      /* expected */
    }
    assert.equal(lockExisted, false, "lock file should not exist before fix");

    const result = await runCli(["fix"], tempDir);

    // fix should succeed
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // Lock files should now exist
    const skillsLock = JSON.parse(await readFile(join(lockDir, "skills-lock.json"), "utf-8"));
    const cliLock = JSON.parse(await readFile(join(lockDir, "cli-lock.json"), "utf-8"));
    assert.equal(skillsLock.version, 1);
    assert.equal(cliLock.version, 1);
    // node should be in the CLI lock
    assert.ok(cliLock.tools.node, "node should be in cli-lock.json");
  });

  it("reports nothing to fix after lock files already exist", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");

    // Run fix twice — second run should also succeed
    await runCli(["fix"], tempDir);
    const result = await runCli(["fix"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stdout.includes("nothing") || result.stdout.includes("exist"),
      "should note that nothing needed fixing",
    );
  });
});

// ---------------------------------------------------------------------------
// kit setup (end-to-end pipeline)
// ---------------------------------------------------------------------------

describe("kit setup", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-setup-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs all 6 pipeline steps with config-sourced secrets", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");

    const result = await runCli(["setup"], tempDir);

    // All steps should complete
    assert.ok(
      result.stdout.includes("[1/6]") && result.stdout.includes("[6/6]"),
      "should show pipeline step numbers",
    );
    // Config secrets always resolve → setup should succeed
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("completes setup pipeline with node tool + config secrets", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_FULL_PIPELINE, "utf-8");

    const result = await runCli(["setup"], tempDir);

    // node is already installed so install step should pass
    assert.ok(result.stdout.includes("[1/6]"), "should show step 1");
    // Verify final step ran
    assert.ok(result.stdout.includes("[6/6]"), "should show step 6");
    // Agent-config step should have wired a CLAUDE.md / AGENTS.md block
    assert.ok(result.stdout.includes("Agent config"), "should run the agent-config step");
  });
});

// ---------------------------------------------------------------------------
// kit check (with no default command arg — same as "check")
// ---------------------------------------------------------------------------

describe("kit default command", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-default-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
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
    await rm(tempDir, { recursive: true, force: true });
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
    await rm(tempDir, { recursive: true, force: true });
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
// kit init — auto-generate .kit.toml
// ---------------------------------------------------------------------------

describe("kit init — auto-generate", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-init-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates .kit.toml for a Next.js project when file is absent (--non-interactive)", async () => {
    const projectDir = join(tempDir, "nextjs-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const result = await runCli(["init", "--non-interactive"], projectDir);

    // Should have generated .kit.toml
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8");
    assert.ok(tomlContent.length > 0, "should generate non-empty .kit.toml");
    assert.ok(tomlContent.includes("node"), "should include node in tools");
    assert.ok(result.stdout.includes(".kit.toml"), `expected generation message: ${result.stdout}`);
  });

  it("shows diff preview with + lines before writing", async () => {
    const projectDir = join(tempDir, "preview-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const result = await runCli(["init", "--non-interactive"], projectDir);
    assert.ok(result.stdout.includes("Preview"), `expected preview header: ${result.stdout}`);
    assert.ok(result.stdout.includes(".kit.toml"), `expected preview content: ${result.stdout}`);
  });

  it("generates --yes as alias for --non-interactive", async () => {
    const projectDir = join(tempDir, "yes-flag-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    await runCli(["init", "--yes"], projectDir);
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8").catch(() => "");
    assert.ok(tomlContent.length > 0, "--yes should write .kit.toml");
  });

  it("does not overwrite existing .kit.toml", async () => {
    const projectDir = join(tempDir, "existing-config");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    const originalContent = `# existing config\n[tools]\nnode = "18"\n`;
    await writeFile(join(projectDir, ".kit.toml"), originalContent, "utf-8");

    await runCli(["init", "--non-interactive"], projectDir);

    // Existing file should be unchanged
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8");
    assert.equal(tomlContent, originalContent, "should not overwrite existing .kit.toml");
  });

  it("returns non-zero when confidence too low in non-interactive mode", async () => {
    const projectDir = join(tempDir, "empty-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    // No package.json, no known files — confidence will be 0

    const result = await runCli(["init", "--non-interactive"], projectDir);
    assert.equal(result.exitCode, 1, "should exit 1 when confidence too low");
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
    await rm(tempDir, { recursive: true, force: true });
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
    await rm(tempDir, { recursive: true, force: true });
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

// Regressions from running kit on third-party / vendor repos: `kit scan` must not
// require (or create) a .kit.toml, and `kit init --no-setup` must actually stop
// after config instead of running the full setup pipeline.
describe("vendor-repo safety: config-free scan + honored --no-setup", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-cfgfree-"));
    await writeFile(join(dir, "package.json"), '{"name":"t","dependencies":{}}', "utf-8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("kit scan runs without a .kit.toml and never creates one", async () => {
    const result = await runCli(["scan"], dir);
    // The regression: a missing config used to ENOENT into "Create a .kit.toml".
    // (Assertion is timeout-safe: that error fires at config-load, before scanners.)
    assert.ok(
      !result.stdout.includes("Create a .kit.toml") &&
        !result.stderr.includes("Create a .kit.toml"),
      `scan must not demand config; got: ${result.stdout}\n${result.stderr}`,
    );
    await assert.rejects(access(join(dir, ".kit.toml")), "scan must not write a .kit.toml");
  });

  it("kit init --no-setup generates config then stops (no install/login/secrets)", async () => {
    const result = await runCli(["init", "--no-setup", "--non-interactive"], dir);
    await access(join(dir, ".kit.toml")); // init's job: the config IS created
    assert.ok(
      /Setup skipped/.test(result.stdout),
      `expected 'Setup skipped'; got: ${result.stdout}`,
    );
  });

  // Project-agnostic commands must not require (or create) a .kit.toml either.
  for (const args of [["supply-chain"], ["sentinel", "status"], ["verify-provenance"]]) {
    it(`kit ${args.join(" ")} runs without a .kit.toml`, async () => {
      const result = await runCli(args, dir);
      assert.ok(
        !result.stdout.includes("Create a .kit.toml") &&
          !result.stderr.includes("Create a .kit.toml"),
        `${args[0]} must not demand config; got: ${result.stdout}\n${result.stderr}`,
      );
      await assert.rejects(access(join(dir, ".kit.toml")), `${args[0]} must not write a .kit.toml`);
    });
  }
});

describe("kit self-audit (clean tree, machine output)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-selfaudit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("--json: ok=true, failed=0, advisories separate from warnings, files carried", async () => {
    const result = await runCli(["self-audit", "--json"], dir);
    assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { status: string; category: string; files?: string[]; severity?: string }[];
      summary: { failed: number; warnings: number; advisories?: number };
    };
    assert.equal(out.ok, true);
    assert.equal(out.summary.failed, 0);
    // Advisories (R5/R10 info) are tallied apart from warnings.
    assert.ok((out.summary.advisories ?? 0) > 0, "expected aggregated advisories on kit's tree");
    // Every non-pass check carries a files path:line (advisory rows are aggregated
    // and carry only a category, so restrict to gating fail/warn rows).
    const gating = out.checks.filter(
      (ch) => (ch.status === "fail" || ch.status === "warn") && ch.severity !== "low",
    );
    for (const ch of gating) {
      assert.ok(
        ch.files && ch.files.length > 0 && /:\d+$/.test(ch.files[0]),
        `non-pass check ${ch.category} must carry a file:line; got ${JSON.stringify(ch.files)}`,
      );
    }
  });

  it("--fail-on-warning exits 0 on the clean tree (advisories never gate)", async () => {
    const result = await runCli(["self-audit", "--fail-on-warning"], dir);
    assert.equal(
      result.exitCode,
      0,
      `--fail-on-warning must pass on kit's clean tree; stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });
});
