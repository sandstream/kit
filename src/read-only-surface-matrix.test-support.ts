/** Shared catalog and isolated CLI fixture for read-only dispatch shards. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface CommandCase {
  label: string;
  args: string[];
  operation: string;
}

const mutation = (label: string, operation: string, ...args: string[]): CommandCase => ({
  label,
  args,
  operation,
});

/**
 * Independent review matrix for every CLI form whose declared purpose can mutate durable local
 * or remote state. Incidental caches and audit receipts produced by read commands are not command
 * mutations; their modules remain responsible for honoring read-only mode internally.
 */
export const MUTATING_COMMANDS: readonly CommandCase[] = [
  mutation("add service", "add-service", "add", "stripe/payments"),
  mutation("adr freeze", "adr-freeze", "adr", "freeze"),
  mutation("agent-config", "agent-config", "agent-config"),
  mutation("analyze --write", "analyze-write", "analyze", "--write"),
  mutation("audit anchor", "audit-anchor", "audit", "anchor"),
  mutation("auth elevate", "auth-elevate", "auth", "elevate"),
  mutation("auth revoke", "auth-revoke", "auth", "revoke"),
  mutation("auth setup-totp", "auth-setup-totp", "auth", "setup-totp"),
  mutation("baseline freeze", "baseline-freeze", "baseline", "freeze"),
  mutation("bootstrap", "bootstrap", "bootstrap"),
  mutation("broker enforce", "broker-enforce", "broker", "enforce"),
  mutation("check --attest", "check-attest", "check", "--attest"),
  mutation(
    "check verify-attestation --pin",
    "check-attestation-pin",
    "check",
    "verify-attestation",
    "receipt.json",
    "--pin",
  ),
  mutation("ci --attest", "ci-attest", "ci", "--attest"),
  mutation("ci --init --write", "ci-init-write", "ci", "--init=gitlab", "--write"),
  mutation("ci gitlab report", "ci-gitlab-report", "ci", "--format=gitlab"),
  mutation("clone", "clone", "clone", "https://example.com/org/repo.git"),
  mutation("config migrate", "config-migrate", "config", "migrate"),
  mutation("context use", "context-use", "context", "use"),
  mutation("create-plugin", "create-plugin", "create-plugin", "demo"),
  mutation("decisions add", "decisions-add", "decisions", "add"),
  mutation("env switch", "env-switch", "env", "switch", "staging"),
  mutation("escalate", "escalate", "escalate"),
  mutation("fix", "fix", "fix"),
  mutation("guard install", "guard-install", "guard", "install"),
  mutation("guard uninstall", "guard-uninstall", "guard", "uninstall"),
  mutation("heal", "heal", "heal"),
  mutation("hooks default install", "hooks-install", "hooks"),
  mutation("hooks install", "hooks-install", "hooks", "install"),
  mutation("hooks sync", "hooks-install", "hooks", "sync"),
  mutation("hooks add", "hooks-add", "hooks", "add", "secret-scan"),
  mutation("hooks uninstall", "hooks-uninstall", "hooks", "uninstall"),
  mutation("identity init", "identity-init", "identity", "init"),
  mutation("identity migrate", "identity-migrate", "identity", "migrate"),
  mutation("identity rotate", "identity-rotate", "identity", "rotate"),
  mutation("init", "init", "init"),
  mutation("install", "install", "install"),
  mutation("login", "login", "login"),
  mutation("mcp clear", "mcp-clear", "mcp", "clear", "sentry"),
  mutation("mcp set-token", "mcp-set-token", "mcp", "set-token", "sentry"),
  mutation("mcp web", "mcp-web-setup", "mcp", "web"),
  mutation("memory backup", "memory-backup", "memory", "backup", "memory.enc"),
  mutation("memory export", "memory-export", "memory", "export", "--obsidian", "vault"),
  mutation("memory forget", "memory-forget", "memory", "forget", "demo"),
  mutation("memory forget-message", "memory-forget-message", "memory", "forget-message", "uuid"),
  mutation("memory hook", "memory-hook", "memory", "hook", "start"),
  mutation("memory index", "memory-index", "memory", "index"),
  mutation("memory install", "memory-install", "memory", "install"),
  mutation("memory keygen", "memory-keygen", "memory", "keygen"),
  mutation("memory merge", "memory-merge", "memory", "merge", "other.db"),
  mutation("memory project init", "memory-project-init", "memory", "project", "init"),
  mutation("memory pal add", "memory-pal-add", "memory", "pal", "add", "todo"),
  mutation("memory pal claim", "memory-pal-claim", "memory", "pal", "claim", "P1"),
  mutation("memory pal renew", "memory-pal-renew", "memory", "pal", "renew", "P1"),
  mutation("memory pal takeover", "memory-pal-takeover", "memory", "pal", "takeover", "P1"),
  mutation(
    "memory pal configure",
    "memory-pal-configure",
    "memory",
    "pal",
    "configure",
    "P1",
    "--manual",
  ),
  mutation("memory pal done", "memory-pal-done", "memory", "pal", "done", "P1"),
  mutation("memory pal import", "memory-pal-import", "memory", "pal", "import"),
  mutation("memory pal prune", "memory-pal-prune", "memory", "pal", "prune"),
  mutation("memory pal release", "memory-pal-release", "memory", "pal", "release", "P1"),
  mutation("memory pal reopen", "memory-pal-reopen", "memory", "pal", "reopen", "P1"),
  mutation("memory pal snooze", "memory-pal-snooze", "memory", "pal", "snooze", "P1"),
  mutation("memory pal verify", "memory-pal-verify", "memory", "pal", "verify"),
  mutation("memory pull", "memory-pull", "memory", "pull"),
  mutation("memory push", "memory-push", "memory", "push"),
  mutation("memory restore", "memory-restore", "memory", "restore", "memory.enc"),
  mutation("memory save", "memory-save", "memory", "save", "demo"),
  mutation("memory scan quarantine", "memory-scan-quarantine", "memory", "scan", "--quarantine"),
  mutation("memory share", "memory-share", "memory", "share"),
  mutation("memory sync", "memory-sync", "memory", "sync", "other.db"),
  mutation("memory uninstall", "memory-uninstall", "memory", "uninstall"),
  mutation("monkey-test init", "monkey-test-init", "monkey-test", "init"),
  mutation(
    "monkey-test run",
    "monkey-test-run",
    "monkey-test",
    "run",
    "--test-command",
    "touch escaped",
  ),
  mutation("panic", "panic", "panic", "--reason", "test"),
  mutation("pkg", "pkg-install", "pkg", "npm:example"),
  mutation("plugin install", "plugin-install", "plugin", "install", "demo"),
  mutation("plugin uninstall", "plugin-uninstall", "plugin", "uninstall", "demo"),
  mutation("plugin scaffold", "plugin-scaffold", "plugin", "scaffold", "demo"),
  mutation("policy approve", "policy-approve", "policy", "approve", "deploy"),
  mutation("policy init", "policy-init", "policy", "init"),
  mutation("policy pull", "policy-pull", "policy", "pull", "remote"),
  mutation(
    "policy pull-revocations",
    "policy-pull-revocations",
    "policy",
    "pull-revocations",
    "remote",
  ),
  mutation("policy sign", "policy-sign", "policy", "sign"),
  mutation("policy trust add", "policy-trust-add", "policy", "trust", "signer.pem"),
  mutation("policy trust remove", "policy-trust-remove", "policy", "trust", "--remove=kid"),
  mutation("profile export --out", "profile-export", "profile", "export", "--out=bundle.json"),
  mutation("profile freeze", "profile-freeze", "profile", "freeze"),
  mutation("profile import", "profile-import", "profile", "import", "bundle.json"),
  mutation("profile sign", "profile-sign", "profile", "sign"),
  mutation("run", "run", "run", "touch", "escaped"),
  mutation("scan update baseline", "scan-update-baseline", "scan", "--update-baseline"),
  mutation("secrets generate", "secrets-generate", "secrets"),
  mutation("secrets migrate", "secrets-migrate", "secrets", "migrate"),
  mutation("secrets onecli register", "secrets-onecli-register", "secrets", "onecli", "register"),
  mutation("secrets propagate", "secrets-propagate", "secrets", "propagate"),
  mutation("secrets purge-history", "secrets-purge-history", "secrets", "purge-history"),
  mutation("secrets revoke-old", "secrets-revoke-old", "secrets", "revoke-old"),
  mutation("secrets rotate", "secrets-rotate", "secrets", "rotate"),
  mutation("secrets set", "secrets-set", "secrets", "set", "TOKEN"),
  mutation("secrets sync dotenv-ci", "secrets-sync", "secrets", "sync", "--target=dotenv-ci"),
  mutation("secrets sync github", "secrets-sync", "secrets", "sync", "--target=github"),
  mutation("secrets validate --auto", "secrets-validate-write", "secrets", "validate", "--auto"),
  mutation("secrets validate --fix", "secrets-validate-write", "secrets", "validate", "--fix"),
  mutation("secrets vault-migrate", "secrets-vault-migrate", "secrets", "vault-migrate"),
  mutation(
    "security advisories --accept",
    "security-advisories-accept",
    "security",
    "advisories",
    "--accept",
  ),
  mutation("security clear-cache", "security-clear-cache", "security", "clear-cache"),
  mutation(
    "security check-gitignore --fix",
    "check-gitignore-fix",
    "security",
    "check-gitignore",
    "--fix",
  ),
  mutation("security policy add", "security-policy-update", "security", "policy", "add", "pkg"),
  mutation("security policy init", "security-policy-update", "security", "policy", "init"),
  mutation("sentinel install", "sentinel-install", "sentinel", "install"),
  mutation("setup", "setup", "setup"),
  mutation(
    "skill snapshot",
    "skill-update-snapshot",
    "skill",
    "test",
    "demo/SKILL.md",
    "--update-snapshot",
  ),
  mutation("standards freeze", "standards-freeze", "standards", "freeze"),
  mutation("team create", "team-create", "team", "create", "demo"),
  mutation("team invite", "team-invite", "team", "invite", "person@example.com"),
  mutation(
    "team member remove",
    "team-member-remove",
    "team",
    "member",
    "remove",
    "person@example.com",
  ),
  mutation("triage all", "triage-record", "triage", "all", "example"),
  mutation("triage brew", "triage-record", "triage", "brew", "example"),
  mutation("triage docker", "triage-record", "triage", "docker", "example"),
  mutation("triage npm", "triage-record", "triage", "npm", "example"),
  mutation("triage pip", "triage-record", "triage", "pip", "example"),
  mutation("triage plugin", "triage-record", "triage", "plugin", "example"),
  mutation("triage repo", "triage-record", "triage", "repo", "example"),
  mutation("triage skill", "triage-record", "triage", "skill", "example"),
  mutation("triage mcp --pin", "triage-mcp-pin", "triage", "mcp", "server", "--pin"),
  mutation("upgrade", "upgrade", "upgrade"),
];

/** Top-level verbs whose user-facing contract is read-only for every invocation. */
export const PURE_READ_COMMANDS = [
  "agent-audit",
  "airgap",
  "browser",
  "coverage",
  "design",
  "doctor",
  "gate-bash",
  "gate-egress",
  "gate-env",
  "gate-fs",
  "gha-audit",
  "governance",
  "guard-observe",
  "health",
  "ingest",
  "insight",
  "map",
  "open",
  "review",
  "sbom",
  "self-audit",
  "skills",
  "slopsquat",
  "status",
  "statusline",
  "supply-chain",
  "tools",
  "usage",
  "verify-provenance",
  "whoami",
] as const;

/** Read forms inside otherwise mutation-capable command families. */
export const READ_INVOCATIONS: readonly string[][] = [
  ["add", "--list"],
  ["adr"],
  ["adr", "check"],
  ["adr", "derive"],
  ["adr", "list"],
  ["analyze"],
  ["audit"],
  ["audit", "export"],
  ["audit", "secrets"],
  ["audit", "verify"],
  ["auth", "elevate", "--list-scopes"],
  ["auth", "status"],
  ["baseline"],
  ["baseline", "show"],
  ["broker"],
  ["broker", "enforce-readiness"],
  ["check"],
  ["check", "compare", "before.json", "after.json"],
  ["check", "verify-attestation", "receipt.json"],
  ["ci", "--init=gitlab"],
  ["config"],
  ["config", "knobs"],
  ["config", "migrate", "--check"],
  ["config", "migrate", "--dry-run"],
  ["config", "recommend"],
  ["config", "sections"],
  ["context"],
  ["context", "check"],
  ["decisions"],
  ["decisions", "list"],
  ["decisions", "verify"],
  ["env", "current"],
  ["env", "diff", "--compare", "production"],
  ["env", "list"],
  ["guard"],
  ["guard", "status"],
  ["heal", "--dry-run"],
  ["hooks", "check"],
  ["identity"],
  ["identity", "keystore"],
  ["identity", "show"],
  ["login", "--plan"],
  ["mcp"],
  ["mcp", "auth", "sentry"],
  ["mcp", "list"],
  ["mcp", "status"],
  ["memory", "area", "cli"],
  ["memory", "areas"],
  ["memory", "context"],
  ["memory", "export", "--obsidian", "vault", "--json"],
  ["memory", "learn"],
  ["memory", "pal"],
  ["memory", "pal", "list"],
  ["memory", "project"],
  ["memory", "project", "show"],
  ["memory", "resume", "demo"],
  ["memory", "scan"],
  ["memory", "search", "query"],
  ["memory", "stats"],
  ["memory", "status"],
  ["memory", "suggest"],
  ["memory", "threads"],
  ["memory", "verify"],
  ["monkey-test"],
  ["monkey-test", "plan"],
  ["plugin", "info", "demo"],
  ["plugin", "list"],
  ["plugin", "search", "demo"],
  ["plugin", "tags"],
  ["policy"],
  ["policy", "check"],
  ["policy", "show"],
  ["policy", "trust"],
  ["policy", "trust", "--list"],
  ["policy", "validate"],
  ["policy", "verify"],
  ["profile"],
  ["profile", "check"],
  ["profile", "export"],
  ["profile", "show"],
  ["profile", "verify"],
  ["scan"],
  ["secrets", "onecli"],
  ["secrets", "onecli", "status"],
  ["secrets", "sync", "--target=github", "--dry-run"],
  ["secrets", "sync", "--target=stdout"],
  ["secrets", "validate"],
  ["security", "advisories"],
  ["security", "check-gitignore"],
  ["security", "policy"],
  ["security", "policy", "check"],
  ["security", "prescan", "."],
  ["security", "scan-artifact", "artifact"],
  ["security", "scan-build"],
  ["security", "scan-staged"],
  ["security", "scan-transcripts"],
  ["security", "verify-pull"],
  ["sentinel", "run"],
  ["sentinel", "status"],
  ["setup", "--mode", "review"],
  ["setup", "--mode=review"],
  ["skill", "test", "demo/SKILL.md"],
  ["standards"],
  ["team", "audit", "log"],
  ["team", "members", "list"],
  ["triage", "check-deps"],
  ["triage", "check-skills"],
  ["triage", "mcp", "server", "--tools", "tools.json"],
  ["triage", "model", "model.bin"],
  ["triage", "tools"],
  ["triage", "vault-config"],
];

const adjacentCli = resolve(import.meta.dirname, "cli.js");
const CLI = existsSync(adjacentCli) ? adjacentCli : resolve(import.meta.dirname, "../dist/cli.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ro-matrix-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "read-only-matrix", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

function refusalOperations(dir: string): string[] {
  const path = join(dir, ".kit-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const event = JSON.parse(line) as {
        operation?: string;
        metadata?: { refused_operation?: string };
      };
      return event.operation === "read-only-mode-refusal"
        ? [event.metadata?.refused_operation ?? ""]
        : [];
    });
}

export const SHARD_COUNT = 8;
export type ReadOnlyMode = "env" | "flag";

export function commandShard(index: number): readonly CommandCase[] {
  assert.ok(Number.isInteger(index) && index >= 0 && index < SHARD_COUNT);
  return MUTATING_COMMANDS.filter((_, commandIndex) => commandIndex % SHARD_COUNT === index);
}

export function runDispatchShard(index: number, mode: ReadOnlyMode): void {
  const commands = commandShard(index);
  const dir = project();
  const home = mkdtempSync(join(tmpdir(), "kit-ro-matrix-home-"));
  try {
    const failures: string[] = [];
    for (const commandCase of commands) {
      const args = mode === "flag" ? [...commandCase.args, "--read-only"] : commandCase.args;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "true",
        HOME: home,
        USERPROFILE: home,
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        KIT_IDENTITY_DIR: join(home, ".kit"),
        KIT_MEMORY_DIR: join(home, ".kit", "memory"),
      };
      delete env.KIT_READ_ONLY;
      if (mode === "env") env.KIT_READ_ONLY = "1";

      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        encoding: "utf-8",
        env,
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 1 || !/read-only mode active/.test(output)) {
        failures.push(
          `${commandCase.label}: exit=${String(result.status)} output=${output.slice(0, 160)}`,
        );
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(
      refusalOperations(dir),
      commands.map(({ operation }) => operation),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
