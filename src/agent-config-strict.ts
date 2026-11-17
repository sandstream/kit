/**
 * The strict half of `kit agent-config` for Claude Code: deny rules and the OS sandbox.
 *
 * The PreToolUse gates inspect a command before it runs; these settings are a second layer that
 * Claude Code enforces itself. Every rule below uses only syntax the Claude Code docs confirm:
 *
 * - Read deny rules with `~/` paths and gitignore patterns, and `!` negation that carves a path out
 *   of the `path` rules listed before it in the same file:
 *   https://code.claude.com/docs/en/permissions (Read and Edit; "Special characters and `!` negation").
 * - Bash rules where `*` stands in for any text at any position (`Bash(git * main)`), and deny rules
 *   that apply to any subcommand of a compound command:
 *   https://code.claude.com/docs/en/permissions (Wildcard patterns; Bash). The docs call argument
 *   patterns fragile (`git -C . push` is not matched), which is why these are a second layer only.
 * - `sandbox.enabled` and `sandbox.filesystem.denyRead`, whose paths take `~/` for home:
 *   https://code.claude.com/docs/en/settings-reference (sandbox.enabled, Sandbox path prefixes,
 *   sandbox.filesystem.denyRead). The sandbox runs on macOS, Linux and WSL2, not native Windows:
 *   https://code.claude.com/docs/en/sandboxing (Platform support).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Credential directories no agent session needs to read. */
export const CREDENTIAL_DIRS = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"];

/** `.env` and `.env.*` at any depth, then `.env.example` carved back out (order matters). */
const ENV_DENY_RULES = ["Read(.env)", "Read(.env.*)"];
export const ENV_EXAMPLE_CARVE_OUT = "Read(!.env.example)";

/** Force push (`--force*`, `-f`, a `+refspec`) and `git reset --hard`, wherever the flag sits. */
const GIT_DENY_RULES = [
  "Bash(git push *--force*)",
  "Bash(git push -f*)",
  "Bash(git push * -f*)",
  "Bash(git push * +*)",
  "Bash(git reset *--hard*)",
];

export const KIT_DENY_RULES: string[] = [
  ...CREDENTIAL_DIRS.map((dir) => `Read(${dir}/**)`),
  ...ENV_DENY_RULES,
  ENV_EXAMPLE_CARVE_OUT,
  ...GIT_DENY_RULES,
];

export type SandboxState =
  "enabled" | "already-enabled" | "user-disabled" | "skipped-win32" | "not-written";

export interface StrictResult {
  file: string;
  addedDeny: string[];
  addedDenyRead: string[];
  sandbox: SandboxState;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
}

interface StrictSettings {
  permissions?: { deny?: string[]; [k: string]: unknown };
  sandbox?: { enabled?: boolean; filesystem?: { denyRead?: string[] }; [k: string]: unknown };
  [k: string]: unknown;
}

/** Append the missing kit deny rules; keep the user's own and their order. Returns what was added. */
export function mergeDenyRules(deny: string[]): { added: string[]; moved: boolean } {
  const added: string[] = [];
  for (const rule of KIT_DENY_RULES) {
    if (deny.includes(rule)) continue;
    deny.push(rule);
    added.push(rule);
  }
  // A `!` rule carves only out of rules listed BEFORE it, so it must follow the .env rules.
  const carve = deny.indexOf(ENV_EXAMPLE_CARVE_OUT);
  const lastEnv = Math.max(...ENV_DENY_RULES.map((r) => deny.indexOf(r)));
  if (carve > lastEnv) return { added, moved: false };
  deny.splice(carve, 1);
  deny.splice(
    deny.indexOf(ENV_DENY_RULES[ENV_DENY_RULES.length - 1]) + 1,
    0,
    ENV_EXAMPLE_CARVE_OUT,
  );
  return { added, moved: true };
}

/** Enable the sandbox (unless the user turned it off) and add the credential read denies. */
function mergeSandbox(
  settings: StrictSettings,
  platform: NodeJS.Platform,
): { state: SandboxState; added: string[] } {
  if (platform === "win32") return { state: "skipped-win32", added: [] };
  const sandbox = (settings.sandbox ??= {});
  let state: SandboxState = "already-enabled";
  if (sandbox.enabled === false) state = "user-disabled";
  else if (sandbox.enabled !== true) {
    sandbox.enabled = true;
    state = "enabled";
  }
  const denyRead = ((sandbox.filesystem ??= {}).denyRead ??= []);
  const added = CREDENTIAL_DIRS.filter((dir) => !denyRead.includes(dir));
  denyRead.push(...added);
  return { state, added };
}

async function readSettings(path: string): Promise<{ settings: StrictSettings; existed: boolean }> {
  try {
    return { settings: JSON.parse(await readFile(path, "utf-8")) as StrictSettings, existed: true };
  } catch {
    return { settings: {}, existed: false }; // absent or unreadable → start fresh
  }
}

/**
 * Merge the deny rules and (off native Windows) the sandbox block into `.claude/settings.json`.
 * Idempotent and non-destructive: the user's own deny rules, sandbox keys and an explicit
 * `sandbox.enabled: false` are kept.
 */
export async function installStrictSettings(
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): Promise<StrictResult> {
  const file = ".claude/settings.json";
  const path = resolve(cwd, file);
  const empty = { file, addedDeny: [], addedDenyRead: [] };
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    return { ...empty, sandbox: "not-written", action: "skipped", detail: "read-only mode" };
  }
  if (!existsSync(resolve(cwd, ".claude")) && !existsSync(resolve(cwd, "CLAUDE.md"))) {
    const detail = "no Claude Code project detected";
    return { ...empty, sandbox: "not-written", action: "skipped", detail };
  }
  const { settings, existed } = await readSettings(path);
  const deny = ((settings.permissions ??= {}).deny ??= []);
  const merged = mergeDenyRules(deny);
  const sandbox = mergeSandbox(settings, platform);
  const result = { file, addedDeny: merged.added, addedDenyRead: sandbox.added };
  const changed =
    merged.added.length > 0 ||
    merged.moved ||
    sandbox.added.length > 0 ||
    sandbox.state === "enabled";
  if (!changed) return { ...result, sandbox: sandbox.state, action: "unchanged" };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { ...result, sandbox: sandbox.state, action: existed ? "updated" : "created" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ...empty, sandbox: sandbox.state, action: "failed", detail };
  }
}

/** One line per outcome for the `kit agent-config` output (no colour; the caller adds it). */
export function describeStrictResult(r: StrictResult): string[] {
  if (r.action === "skipped") return [`· deny rules + sandbox skipped: ${r.detail ?? "skipped"}`];
  if (r.action === "failed") return [`! could not update ${r.file}: ${r.detail}`];
  const lines = [
    r.addedDeny.length > 0
      ? `✓ ${r.addedDeny.length} deny rule(s) (credential dirs, .env*, force push, reset --hard) → ${r.file}`
      : `= deny rules already present in ${r.file}`,
  ];
  const sandbox: Record<SandboxState, string> = {
    enabled: `✓ sandbox enabled, ${r.addedDenyRead.length} credential dir(s) denied to sandboxed reads`,
    "already-enabled": `= sandbox already enabled (${r.addedDenyRead.length} credential dir(s) added to denyRead)`,
    "user-disabled": `! sandbox.enabled is false in ${r.file}; left as set (credential denyRead still written)`,
    "skipped-win32":
      "· sandbox not written: Claude Code's sandbox does not run on native Windows (use WSL2)",
    "not-written": "· sandbox not written",
  };
  lines.push(sandbox[r.sandbox]);
  return lines;
}
