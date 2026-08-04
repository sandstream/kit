/**
 * kit's declared WRITE SURFACE — the entry points read-only mode must refuse, checked once at
 * dispatch instead of once per handler.
 *
 * WHY A TABLE AND NOT MORE PER-MODULE GUARDS: read-only mode was guarded inside 11 modules
 * (hooks, elevation, fix, secrets-migrate, context-lock, agent-config, env-switch, install,
 * mcp-server, …) and the plumbing worked — `kit fix` under `KIT_READ_ONLY=1` refuses, exits 1 and
 * audit-logs the refusal. But a behavioural sweep over the claim
 * "Read-only mode refuses every mutation" found four commands that wrote anyway:
 *
 *     kit identity init                → minted a fresh Ed25519 PRIVATE KEY
 *     kit policy init                  → created .kit-policy.toml
 *     kit security check-gitignore --fix → rewrote .gitignore (1 → 16 lines)
 *     kit upgrade                      → rewrote both lock files
 *
 * None refused, none was audited. An operator who locks an agent session down with
 * KIT_READ_ONLY=1 believing "every mutation" is refused would have the agent mint a new signing
 * identity under it — the identity that then attributes audit and policy signatures.
 *
 * Guarding those four modules individually would fix today and rot tomorrow: the defect is not
 * four missing guards, it is that nothing enumerated the write surface, so "did we cover
 * everything?" had no answer. This table IS that answer, and `read-only-surface.test.ts` drives
 * every entry behaviourally, so an entry that stops refusing fails the suite.
 *
 * The per-module guards stay. They cover library callers that never pass through the CLI
 * dispatcher (the MCP server, plugins, `withGovernance` closures) and they carry operation-specific
 * metadata into the audit trail. This table is the floor, not a replacement.
 *
 * ADDING A COMMAND: if it can write outside /tmp — a file, a key, a lock, a remote resource — it
 * belongs here. A command missing from the table is not "allowed in read-only mode", it is
 * unreviewed.
 */

/** A mutating entry point: a command, optionally narrowed to a subcommand and/or a flag. */
export interface WriteSurfaceEntry {
  /** argv[2] — the command verb. */
  command: string;
  /**
   * argv[3] — when only some subcommands mutate. `kit policy show` reads, `kit policy init`
   * writes; omitting this would refuse the read too, which trains people to drop the flag.
   */
  subcommand?: string;
  /**
   * When the mutation is opt-in behind a flag: `kit security check-gitignore` reports,
   * `--fix` rewrites. Only the flagged form is refused.
   */
  flag?: string;
  /** The operation name recorded in the audit trail (`refused_operation`). */
  operation: string;
}

/**
 * The declared write surface. Kept alphabetical by command for reviewability.
 *
 * Deliberately NOT here:
 *   - `check`, `doctor`, `coverage`, `map`, `insight`, `status` — read-only by construction.
 *   - `run` / `triage` / `secrets` / `fix` / `init` — already refused inside their own modules or
 *     via the MCP guards, and they carry richer metadata there than this table can. Listing them
 *     twice would produce two audit entries for one refusal.
 *
 *     READ THAT EXCLUSION CAREFULLY, because it was wrong once. "Already refused inside their own
 *     modules" is a claim about a MODULE, and a module can hold more than one write. `secrets`
 *     refused the LOCAL secret write (`writeSecretToBackend` → `refuseWrite`) while
 *     `secrets-propagate.ts` wrote the same secret into a third-party control plane with no
 *     read-only check at all — measured: with elevation satisfied, `KIT_READ_ONLY=1 kit secrets
 *     propagate ... --to vercel` reached `spawn vercel`. Fixed at `propagate()`'s own choke point.
 *     Before excluding a command from this table, enumerate its writes, not its modules.
 */
export const WRITE_SURFACE: readonly WriteSurfaceEntry[] = [
  // Mints or rotates a signing key, or records a revocation — the worst thing to allow under a
  // lock-down, because it changes WHO later artifacts are attributed to.
  { command: "identity", subcommand: "init", operation: "identity-init" },
  { command: "identity", subcommand: "rotate", operation: "identity-rotate" },
  { command: "identity", subcommand: "migrate", operation: "identity-migrate" },
  // Creates or re-signs the org policy document that other gates read as authority.
  { command: "policy", subcommand: "init", operation: "policy-init" },
  { command: "policy", subcommand: "sign", operation: "policy-sign" },
  // Signs / freezes / imports the traveling profile.
  { command: "profile", subcommand: "freeze", operation: "profile-freeze" },
  { command: "profile", subcommand: "sign", operation: "profile-sign" },
  { command: "profile", subcommand: "import", operation: "profile-import" },
  // Rewrites .gitignore in place. Only the --fix form mutates.
  {
    command: "security",
    subcommand: "check-gitignore",
    flag: "--fix",
    operation: "check-gitignore-fix",
  },
  // Rewrites the lock files (cli-lock.json, skills-lock.json).
  { command: "upgrade", operation: "upgrade" },
];

/**
 * Decide whether this argv is a declared mutation. Pure — no I/O, no env reads — so the
 * dispatcher's behaviour under read-only mode is a function of argv alone and is testable
 * without a filesystem.
 *
 * `argv` is the full process.argv (argv[2] = command, argv[3] = subcommand).
 */
export function matchWriteSurface(argv: readonly string[]): WriteSurfaceEntry | null {
  const command = argv[2];
  if (!command) return null;
  const subcommand = argv[3];
  for (const entry of WRITE_SURFACE) {
    if (entry.command !== command) continue;
    // An entry with a subcommand matches only that subcommand. An entry without one matches the
    // command regardless — `kit upgrade` mutates however it is invoked.
    if (entry.subcommand !== undefined && entry.subcommand !== subcommand) continue;
    // A flagged entry matches only when the flag is present: the unflagged form is a read.
    if (entry.flag !== undefined && !argv.includes(entry.flag)) continue;
    return entry;
  }
  return null;
}
