/**
 * T3 Code: the permission mode it starts agents in, and the scripts a repository's `t3.json` runs.
 *
 * T3 Code launches Claude Code, Codex and other agents itself (kit-research#241). Read from
 * `pingdotgg/t3code` 0.1.13 as data, never run:
 *
 * - **Runtime mode.** A new thread starts at `defaultRuntimeMode`, one of `approval-required`,
 *   `auto-accept-edits`, `auto` and `full-access`; `DEFAULT_RUNTIME_MODE = "full-access"`
 *   (`packages/contracts/src/providerPolicy.ts`). Full access is Claude `bypassPermissions` with
 *   `allowDangerouslySkipPermissions`, and Codex `danger-full-access` with every approval off, so it
 *   gets the same warning as Claude's `defaultMode: "bypassPermissions"`. The settings live in
 *   `<base>/userdata/settings.json`, where `<base>` is `$T3CODE_HOME` or `~/.t3`
 *   (`apps/server/src/os-jank.ts` `resolveBaseDir`, `config.ts` `deriveServerPaths`). T3 strips
 *   defaults before writing it (`serverSettings.ts` `stripDefaultServerSettings`), so an absent key
 *   is Full access. Per-project values sit in `projectSettingsOverrides.<projectId>`.
 * - **Managed policy** (`docs/user/managed-policy.md`): a policy file can set
 *   `settings.defaultRuntimeMode` (`value`, `locked`) and cap every mode with
 *   `limits.maxRuntimeMode`. kit reads the policy file for this platform; native policies (a macOS
 *   profile, the Windows registry or GPO) are not read.
 * - **`t3.json`** at the repository root (`packages/contracts/src/t3ProjectFile.ts`): `scripts[]`
 *   with `runOnWorktreeCreate` run when a worktree is created for a new thread, and those with
 *   `runOnSettle` each time the thread settles. That is code the repository supplies and T3 runs on
 *   its own once the scripts are imported. Every command there, and `worktreeLayout.create` /
 *   `remove`, is also read for malware shapes.
 *
 * Read-only: reads at most three JSON files and runs nothing they name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditHookBody } from "./agent-audit.js";
import type { SecurityCheckResult } from "./check-security.js";

const FULL = "full-access";
const MODES = ["approval-required", "auto-accept-edits", "auto", FULL];

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function parse(text: string | null): Json | null {
  if (text === null) return null;
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const mode = (v: unknown): string | undefined =>
  typeof v === "string" && MODES.includes(v) ? v : undefined;

/** T3 Code's base directory and how it is shown. Pure. */
function t3Home(home: string, env: Record<string, unknown>): { dir: string; shown: string } {
  const set = typeof env.T3CODE_HOME === "string" && env.T3CODE_HOME.trim() !== "";
  return set
    ? { dir: String(env.T3CODE_HOME).trim(), shown: "$T3CODE_HOME" }
    : { dir: join(home, ".t3"), shown: "~/.t3" };
}

/** The managed policy file T3 Code reads on this platform. */
function t3PolicyPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, unknown> = process.env,
): string {
  if (platform === "darwin") return "/Library/Application Support/T3Code/policy.json";
  if (platform === "win32") {
    const pf = typeof env.ProgramFiles === "string" ? env.ProgramFiles : "C:\\Program Files";
    return join(pf, "T3Code", "policy.json");
  }
  return "/etc/t3code/policy.json";
}

/** Where a mode comes from, for the detail. */
interface Effective {
  mode: string;
  source: string;
  locked: boolean;
}

/** The default mode for new threads: a locked policy value, else the user's, else the policy's. */
function effectiveDefault(settings: Json, policy: Json, shownFile: string): Effective {
  const p = obj(obj(policy.settings).defaultRuntimeMode);
  const policyMode = mode(p.value);
  if (policyMode && p.locked === true) {
    return { mode: policyMode, source: "the managed policy (locked)", locked: true };
  }
  const own = mode(settings.defaultRuntimeMode);
  if (own) return { mode: own, source: `defaultRuntimeMode in ${shownFile}`, locked: false };
  if (policyMode) return { mode: policyMode, source: "the managed policy", locked: false };
  return { mode: FULL, source: "T3 Code's default (no defaultRuntimeMode set)", locked: false };
}

/** The project ids whose override sets Full access. */
function fullAccessProjects(settings: Json): string[] {
  return Object.entries(obj(settings.projectSettingsOverrides))
    .filter(([, o]) => mode(obj(o).defaultRuntimeMode) === FULL)
    .map(([id]) => id);
}

/** What starts in Full access: the default and the project overrides. Pure. */
export function t3FullAccess(
  settings: Json,
  policy: Json,
  shownFile: string,
): { default: Effective | null; projects: string[] } {
  const cap = mode(obj(policy.limits).maxRuntimeMode);
  if (cap && cap !== FULL) return { default: null, projects: [] };
  const def = effectiveDefault(settings, policy, shownFile);
  return {
    default: def.mode === FULL ? def : null,
    projects: def.locked ? [] : fullAccessProjects(settings),
  };
}

const SUGGESTION =
  "in T3 Code set Settings → Threads → New threads → Permissions to Supervised or Auto (or defaultRuntimeMode), so the agents it starts ask before running commands";

function modeRows(full: ReturnType<typeof t3FullAccess>, shown: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  if (full.default) {
    rows.push({
      category: "exposure",
      name: "T3 Code starts agents with approvals off",
      status: "warn",
      severity: "medium",
      detail: `new threads run in Full access (Claude bypassPermissions, Codex danger-full-access), from ${full.default.source}`,
      suggestion: SUGGESTION,
    });
  }
  if (full.projects.length > 0) {
    rows.push({
      category: "exposure",
      name: "T3 Code project starts agents with approvals off",
      status: "warn",
      severity: "medium",
      detail: `${full.projects.length} project override(s) in ${shown} set Full access: ${full.projects.slice(0, 3).join(", ")}`,
      suggestion: SUGGESTION,
    });
  }
  return rows;
}

/** The runtime-mode rows, when T3 Code has a state directory here. */
function runtimeModeRows(home: string, env: Record<string, unknown>): SecurityCheckResult[] {
  const base = t3Home(home, env);
  const userdata = join(base.dir, "userdata");
  if (!existsSync(userdata)) return [];
  const shown = `${base.shown}/userdata/settings.json`;
  const settings = parse(readText(join(userdata, "settings.json"))) ?? {};
  const policy = parse(readText(t3PolicyPath(process.platform, env))) ?? {};
  return modeRows(t3FullAccess(settings, policy, shown), shown);
}

interface Script {
  name: string;
  command: string;
  when: string[];
}

function scriptsOf(t3: Json): Script[] {
  const list = Array.isArray(t3.scripts) ? t3.scripts : [];
  return list.map(obj).flatMap((s) => {
    if (typeof s.command !== "string") return [];
    const when = [
      ...(s.runOnWorktreeCreate === true ? ["on worktree create"] : []),
      ...(s.runOnSettle === true ? ["on settle"] : []),
    ];
    const name = typeof s.name === "string" ? s.name : "(unnamed)";
    return [{ name, command: s.command, when }];
  });
}

/** Every command a `t3.json` declares, with where it sits. Pure. */
function t3Commands(t3: Json): { where: string; command: string }[] {
  const layout = obj(t3.worktreeLayout);
  const out = scriptsOf(t3).map((s) => ({ where: `scripts "${s.name}"`, command: s.command }));
  for (const key of ["create", "remove"]) {
    const command = layout[key];
    if (typeof command === "string") out.push({ where: `worktreeLayout.${key}`, command });
  }
  return out;
}

const preview = (command: string): string =>
  command.length > 80 ? `${command.slice(0, 77)}...` : command;

/** Rows for a `t3.json` text: auto-run scripts, and malware-shaped commands. Pure. */
export function t3ProjectFileRows(text: string): SecurityCheckResult[] {
  const t3 = parse(text);
  if (t3 === null) return [];
  const rows: SecurityCheckResult[] = [];
  const auto = scriptsOf(t3).filter((s) => s.when.length > 0);
  if (auto.length > 0) {
    const shown = auto
      .slice(0, 3)
      .map((s) => `"${s.name}" (${s.when.join(", ")}): ${preview(s.command)}`);
    rows.push({
      category: "exposure",
      name: "auto-run script in t3.json",
      status: "warn",
      severity: "medium",
      detail: `${auto.length} repository-supplied script(s) T3 Code runs on its own: ${shown.join("; ")}`,
      suggestion:
        "read each command before importing this repository's scripts into T3 Code: it runs with your account in every new worktree or settled thread",
    });
  }
  for (const { where, command } of t3Commands(t3)) {
    for (const why of auditHookBody(command)) {
      rows.push({
        category: "exposure",
        name: `malware-shaped command in t3.json (${where})`,
        status: "fail",
        severity: "high",
        detail: `${where} ${why}`,
        suggestion: `review ${where} in t3.json before T3 Code runs it`,
      });
    }
  }
  return rows;
}

/** T3 Code's rows for `kit agent-audit` and `kit check`. */
export function runT3Audit(
  root: string,
  home: string,
  env: Record<string, unknown> = process.env,
): SecurityCheckResult[] {
  const project = readText(join(root, "t3.json"));
  return [...runtimeModeRows(home, env), ...(project === null ? [] : t3ProjectFileRows(project))];
}
