/**
 * kit's declared WRITE SURFACE: every CLI entry point that can mutate durable local or remote
 * state. The dispatcher checks this once before invoking a handler, so read-only enforcement does
 * not depend on every module remembering its own guard.
 *
 * Module-level guards remain required for library and MCP callers. This table is the CLI floor.
 * `read-only-surface-matrix.test.ts` independently accounts for every registered top-level command,
 * every known mutating invocation, and the read forms inside mixed command families.
 *
 * ADDING A COMMAND: classify it in that matrix. If it can write a file, key, lock, database, or
 * remote resource, add a rule here. A new top-level command left unreviewed fails the matrix.
 */

export interface FlagValueConstraint {
  flag: string;
  values: readonly string[];
}

/** A mutating CLI pattern and the operation recorded when read-only mode refuses it. */
export interface WriteSurfaceEntry {
  /** argv[2]: top-level command. */
  command: string;
  /** argv[3]. `null` means no positional subcommand (flags do not count as positionals). */
  subcommand?: string | null;
  /** Match any listed argv[3] value; `null` has the same meaning as above. */
  subcommands?: readonly (string | null)[];
  /** argv[4], for nested forms such as `security policy init` or `memory pal add`. */
  argument?: string;
  /** Match any listed argv[4] value. */
  arguments?: readonly string[];
  /** Backward-compatible single required flag. */
  flag?: string;
  /** At least one of these flags must be present. */
  anyFlags?: readonly string[];
  /** Every one of these flags must be present. */
  allFlags?: readonly string[];
  /** Each flag must have one of its listed values. Supports `--flag=x` and `--flag x`. */
  flagValues?: readonly FlagValueConstraint[];
  /** Do not match when any of these flags is present. */
  unlessFlags?: readonly string[];
  /** Do not match when a flag has one of these values. */
  unlessFlagValues?: readonly FlagValueConstraint[];
  /** Require a non-flag positional token at this absolute argv index. */
  positionalAt?: number;
  /** Unambiguous audit metadata (`refused_operation`). */
  operation: string;
}

/**
 * Declared mutation patterns, alphabetical by top-level command. Rules for one command are ordered
 * from specific to broad. Multiple invocation forms sharing one semantic write use one rule so
 * operation names stay unique.
 */
export const WRITE_SURFACE: readonly WriteSurfaceEntry[] = [
  { command: "add", positionalAt: 3, unlessFlags: ["--list"], operation: "add-service" },
  { command: "adr", subcommand: "freeze", operation: "adr-freeze" },
  { command: "agent-config", operation: "agent-config" },
  { command: "analyze", anyFlags: ["--write"], operation: "analyze-write" },
  { command: "audit", subcommand: "anchor", operation: "audit-anchor" },
  {
    command: "auth",
    subcommand: "elevate",
    unlessFlags: ["--list-scopes"],
    operation: "auth-elevate",
  },
  { command: "auth", subcommand: "revoke", operation: "auth-revoke" },
  { command: "auth", subcommand: "setup-totp", operation: "auth-setup-totp" },
  { command: "baseline", subcommand: "freeze", operation: "baseline-freeze" },
  { command: "bootstrap", operation: "bootstrap" },
  { command: "broker", subcommand: "enforce", operation: "broker-enforce" },
  {
    command: "check",
    subcommand: "verify-attestation",
    anyFlags: ["--pin"],
    operation: "check-attestation-pin",
  },
  { command: "check", subcommand: null, anyFlags: ["--attest"], operation: "check-attest" },
  {
    command: "ci",
    allFlags: ["--init", "--write"],
    operation: "ci-init-write",
  },
  {
    command: "ci",
    flagValues: [{ flag: "--format", values: ["gitlab"] }],
    operation: "ci-gitlab-report",
  },
  { command: "ci", anyFlags: ["--attest"], operation: "ci-attest" },
  { command: "clone", operation: "clone" },
  {
    command: "config",
    subcommand: "migrate",
    unlessFlags: ["--check", "--dry-run"],
    operation: "config-migrate",
  },
  { command: "context", subcommand: "use", operation: "context-use" },
  { command: "create-plugin", operation: "create-plugin" },
  { command: "decisions", subcommand: "add", operation: "decisions-add" },
  { command: "env", subcommand: "switch", operation: "env-switch" },
  { command: "escalate", operation: "escalate" },
  { command: "fix", operation: "fix" },
  { command: "guard", subcommand: "install", operation: "guard-install" },
  { command: "guard", subcommand: "uninstall", operation: "guard-uninstall" },
  { command: "heal", unlessFlags: ["--dry-run"], operation: "heal" },
  {
    command: "hooks",
    subcommands: [null, "install", "sync"],
    operation: "hooks-install",
  },
  { command: "hooks", subcommand: "add", operation: "hooks-add" },
  { command: "hooks", subcommand: "uninstall", operation: "hooks-uninstall" },
  { command: "identity", subcommand: "init", operation: "identity-init" },
  { command: "identity", subcommand: "migrate", operation: "identity-migrate" },
  { command: "identity", subcommand: "rotate", operation: "identity-rotate" },
  { command: "init", operation: "init" },
  { command: "install", operation: "install" },
  { command: "login", unlessFlags: ["--plan"], operation: "login" },
  { command: "mcp", subcommand: "clear", operation: "mcp-clear" },
  { command: "mcp", subcommand: "set-token", operation: "mcp-set-token" },
  { command: "mcp", subcommand: "web", operation: "mcp-web-setup" },
  { command: "memory", subcommand: "backup", operation: "memory-backup" },
  {
    command: "memory",
    subcommand: "export",
    anyFlags: ["--obsidian"],
    unlessFlags: ["--json"],
    operation: "memory-export",
  },
  { command: "memory", subcommand: "forget", operation: "memory-forget" },
  {
    command: "memory",
    subcommand: "forget-message",
    operation: "memory-forget-message",
  },
  { command: "memory", subcommand: "hook", operation: "memory-hook" },
  { command: "memory", subcommand: "index", operation: "memory-index" },
  { command: "memory", subcommand: "install", operation: "memory-install" },
  { command: "memory", subcommand: "keygen", operation: "memory-keygen" },
  { command: "memory", subcommand: "merge", operation: "memory-merge" },
  { command: "memory", subcommand: "pal", argument: "add", operation: "memory-pal-add" },
  { command: "memory", subcommand: "pal", argument: "claim", operation: "memory-pal-claim" },
  { command: "memory", subcommand: "pal", argument: "renew", operation: "memory-pal-renew" },
  { command: "memory", subcommand: "pal", argument: "takeover", operation: "memory-pal-takeover" },
  {
    command: "memory",
    subcommand: "pal",
    argument: "configure",
    operation: "memory-pal-configure",
  },
  { command: "memory", subcommand: "pal", argument: "done", operation: "memory-pal-done" },
  { command: "memory", subcommand: "pal", argument: "import", operation: "memory-pal-import" },
  { command: "memory", subcommand: "pal", argument: "prune", operation: "memory-pal-prune" },
  { command: "memory", subcommand: "pal", argument: "reopen", operation: "memory-pal-reopen" },
  { command: "memory", subcommand: "pal", argument: "resolve", operation: "memory-pal-resolve" },
  { command: "memory", subcommand: "pal", argument: "forget", operation: "memory-pal-forget" },
  {
    command: "memory",
    subcommand: "pal",
    argument: "release",
    operation: "memory-pal-release",
  },
  {
    command: "memory",
    subcommand: "pal",
    argument: "snooze",
    operation: "memory-pal-snooze",
  },
  { command: "memory", subcommand: "pal", argument: "verify", operation: "memory-pal-verify" },
  { command: "memory", subcommand: "pull", operation: "memory-pull" },
  {
    command: "memory",
    subcommand: "project",
    argument: "init",
    operation: "memory-project-init",
  },
  { command: "memory", subcommand: "push", operation: "memory-push" },
  { command: "memory", subcommand: "restore", operation: "memory-restore" },
  { command: "memory", subcommand: "save", operation: "memory-save" },
  {
    command: "memory",
    subcommand: "scan",
    anyFlags: ["--quarantine"],
    operation: "memory-scan-quarantine",
  },
  { command: "memory", subcommand: "share", operation: "memory-share" },
  { command: "memory", subcommand: "sync", operation: "memory-sync" },
  { command: "memory", subcommand: "uninstall", operation: "memory-uninstall" },
  { command: "monkey-test", subcommand: "init", operation: "monkey-test-init" },
  { command: "monkey-test", subcommand: "run", operation: "monkey-test-run" },
  { command: "panic", operation: "panic" },
  { command: "pkg", operation: "pkg-install" },
  { command: "plugin", subcommand: "install", operation: "plugin-install" },
  { command: "plugin", subcommand: "scaffold", operation: "plugin-scaffold" },
  { command: "policy", subcommand: "approve", operation: "policy-approve" },
  { command: "policy", subcommand: "init", operation: "policy-init" },
  { command: "policy", subcommand: "pull", operation: "policy-pull" },
  {
    command: "policy",
    subcommand: "pull-revocations",
    operation: "policy-pull-revocations",
  },
  { command: "policy", subcommand: "sign", operation: "policy-sign" },
  {
    command: "policy",
    subcommand: "trust",
    positionalAt: 4,
    unlessFlags: ["--list", "--remove"],
    operation: "policy-trust-add",
  },
  {
    command: "policy",
    subcommand: "trust",
    anyFlags: ["--remove"],
    operation: "policy-trust-remove",
  },
  {
    command: "profile",
    subcommand: "export",
    anyFlags: ["--out"],
    operation: "profile-export",
  },
  { command: "profile", subcommand: "freeze", operation: "profile-freeze" },
  { command: "profile", subcommand: "import", operation: "profile-import" },
  { command: "profile", subcommand: "sign", operation: "profile-sign" },
  { command: "run", operation: "run" },
  { command: "scan", anyFlags: ["--update-baseline"], operation: "scan-update-baseline" },
  { command: "secrets", subcommand: null, operation: "secrets-generate" },
  { command: "secrets", subcommand: "migrate", operation: "secrets-migrate" },
  {
    command: "secrets",
    subcommand: "onecli",
    argument: "register",
    operation: "secrets-onecli-register",
  },
  { command: "secrets", subcommand: "propagate", operation: "secrets-propagate" },
  { command: "secrets", subcommand: "purge-history", operation: "secrets-purge-history" },
  { command: "secrets", subcommand: "revoke-old", operation: "secrets-revoke-old" },
  { command: "secrets", subcommand: "rotate", operation: "secrets-rotate" },
  { command: "secrets", subcommand: "set", operation: "secrets-set" },
  {
    command: "secrets",
    subcommand: "sync",
    flagValues: [{ flag: "--target", values: ["dotenv-ci", "github"] }],
    unlessFlags: ["--dry-run"],
    operation: "secrets-sync",
  },
  {
    command: "secrets",
    subcommand: "validate",
    anyFlags: ["--auto", "--fix"],
    operation: "secrets-validate-write",
  },
  {
    command: "secrets",
    subcommand: "vault-migrate",
    operation: "secrets-vault-migrate",
  },
  {
    command: "security",
    subcommand: "advisories",
    anyFlags: ["--accept"],
    operation: "security-advisories-accept",
  },
  { command: "security", subcommand: "clear-cache", operation: "security-clear-cache" },
  {
    command: "security",
    subcommand: "check-gitignore",
    anyFlags: ["--fix"],
    operation: "check-gitignore-fix",
  },
  {
    command: "security",
    subcommand: "policy",
    arguments: ["add", "init"],
    operation: "security-policy-update",
  },
  { command: "sentinel", subcommand: "install", operation: "sentinel-install" },
  {
    command: "setup",
    unlessFlagValues: [{ flag: "--mode", values: ["review"] }],
    operation: "setup",
  },
  {
    command: "skill",
    subcommand: "test",
    anyFlags: ["--update-snapshot"],
    operation: "skill-update-snapshot",
  },
  { command: "standards", subcommand: "freeze", operation: "standards-freeze" },
  { command: "team", subcommand: "create", operation: "team-create" },
  { command: "team", subcommand: "invite", operation: "team-invite" },
  {
    command: "team",
    subcommand: "member",
    argument: "remove",
    operation: "team-member-remove",
  },
  {
    command: "triage",
    subcommands: ["all", "brew", "docker", "npm", "pip", "plugin", "repo", "skill"],
    operation: "triage-record",
  },
  {
    command: "triage",
    subcommand: "mcp",
    anyFlags: ["--pin"],
    operation: "triage-mcp-pin",
  },
  { command: "upgrade", operation: "upgrade" },
];

function positional(argv: readonly string[], index: number): string | null {
  const value = argv[index];
  return value && !value.startsWith("-") ? value : null;
}

function hasCliFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((value) => value === flag || value.startsWith(`${flag}=`));
}

function cliFlagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
    if (value === flag) {
      const next = argv[index + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
  }
  return undefined;
}

function matchesFlagValues(
  argv: readonly string[],
  constraints: readonly FlagValueConstraint[] | undefined,
): boolean {
  return (
    constraints === undefined ||
    constraints.every(({ flag, values }) => {
      const value = cliFlagValue(argv, flag);
      return value !== undefined && values.includes(value);
    })
  );
}

/** Every subcommand value this command declares a rule for (null excluded). */
function knownSubcommands(command: string): Set<string> {
  const known = new Set<string>();
  for (const entry of WRITE_SURFACE) {
    if (entry.command !== command) continue;
    if (typeof entry.subcommand === "string") known.add(entry.subcommand);
    for (const value of entry.subcommands ?? []) {
      if (typeof value === "string") known.add(value);
    }
  }
  return known;
}

function matchesPositionals(entry: WriteSurfaceEntry, argv: readonly string[]): boolean {
  const rawSubcommand = positional(argv, 3);
  if (entry.subcommand !== undefined) {
    // RO-3: a `subcommand: null` rule guards a command's DEFAULT action. A positional
    // that names none of this command's other declared subcommands is not a subcommand
    // at all from the handler's point of view: the handler (correctly, after its own
    // fix) rejects it, but the classifier used to miss it too, since `"zzz" !== null`
    // failed this rule. Treat an unrecognized token the same as no subcommand so the
    // read-only floor still catches the default action even if a handler regresses.
    // Scoped to the singular field only: a `subcommands` (plural) list, e.g. hooks,
    // already enumerates every non-mutating form it cares about and must not have
    // an unrelated unknown token quietly redirected into one of its listed entries.
    const subcommand =
      entry.subcommand === null &&
      rawSubcommand !== null &&
      !knownSubcommands(entry.command).has(rawSubcommand)
        ? null
        : rawSubcommand;
    if (entry.subcommand !== subcommand) return false;
  }
  if (entry.subcommands !== undefined && !entry.subcommands.includes(rawSubcommand)) return false;

  const argument = positional(argv, 4);
  if (entry.argument !== undefined && entry.argument !== argument) return false;
  if (entry.arguments !== undefined && (argument === null || !entry.arguments.includes(argument)))
    return false;

  if (entry.positionalAt !== undefined && positional(argv, entry.positionalAt) === null)
    return false;
  return true;
}

function matchesRequiredFlags(entry: WriteSurfaceEntry, argv: readonly string[]): boolean {
  const anyFlags = entry.anyFlags ?? (entry.flag ? [entry.flag] : undefined);
  if (anyFlags !== undefined && !anyFlags.some((flag) => hasCliFlag(argv, flag))) return false;
  if (entry.allFlags !== undefined && !entry.allFlags.every((flag) => hasCliFlag(argv, flag)))
    return false;
  return matchesFlagValues(argv, entry.flagValues);
}

function matchesExclusions(entry: WriteSurfaceEntry, argv: readonly string[]): boolean {
  if (entry.unlessFlags?.some((flag) => hasCliFlag(argv, flag))) return false;
  if (
    entry.unlessFlagValues?.some(({ flag, values }) => {
      const value = cliFlagValue(argv, flag);
      return value !== undefined && values.includes(value);
    })
  )
    return false;

  return true;
}

function matchesEntry(entry: WriteSurfaceEntry, argv: readonly string[]): boolean {
  return (
    entry.command === argv[2] &&
    matchesPositionals(entry, argv) &&
    matchesRequiredFlags(entry, argv) &&
    matchesExclusions(entry, argv)
  );
}

/**
 * Return the declared mutation matching a normalized process.argv, or null for a read. Pure: no
 * I/O and no environment reads. cli.ts normalizes leading global flags before calling this.
 */
export function matchWriteSurface(argv: readonly string[]): WriteSurfaceEntry | null {
  for (const entry of WRITE_SURFACE) {
    if (matchesEntry(entry, argv)) return entry;
  }
  return null;
}
