/**
 * `kit agent-config --plan` and `--apply <hash>`: show what agent-config will change in the Claude
 * Code settings files before it writes them, and write only the plan that was shown.
 *
 * The plan is not a second copy of the writers. The settings files are copied into a temporary
 * directory that mirrors the project (or the home directory with `--user`), the real writers from
 * agent-config.ts run against that copy, and the copy is read back and diffed against the real
 * files. The real files, the gate marker, the wrapper and the rules files are never touched.
 *
 * Two invariants are checked on every file, from the parsed JSON:
 *   1. nothing outside `hooks` changes, except the keys agent-config owns (OWNED_OUTSIDE_HOOKS);
 *   2. every hook entry that is not kit's is still there, in the same order.
 * The plan hash is a sha256 over each file's path and its content after the plan, in path order.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  detectAgentTargets,
  installEnvWriteGate,
  installInstallGate,
  installBrokerGates,
  installKitPermissions,
  installLimitsGate,
} from "./agent-config.js";
import { installStrictSettings } from "./agent-config-strict.js";
import { installUserGates } from "./agent-config-user.js";
import { GATE_SUBCOMMANDS, commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import { gateSettingsFile } from "./gate-settings.js";
import { kitWrapperPath } from "./kit-wrapper.js";
import { isReadOnlyMode } from "./read-only-mode.js";
import { installSessionStartCheck } from "./session-start-gate.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { flagValue, hasFlag } from "./utils/flags.js";
import { isNonInteractive } from "./environment.js";

const SHARED = ".claude/settings.json";

/**
 * Keys outside `hooks` that agent-config writes today, in `.claude/settings.json` only:
 * `permissions.allow` (installKitPermissions: kit's read-only commands), and `permissions.deny`,
 * `sandbox.enabled`, `sandbox.filesystem.denyRead` (installStrictSettings). The gate file
 * (`settings.local.json` when settings.json is tracked) and the user file get hooks only.
 */
export const OWNED_OUTSIDE_HOOKS = [
  "permissions.allow",
  "permissions.deny",
  "sandbox.enabled",
  "sandbox.filesystem.denyRead",
];

/** Hook subcommands agent-config writes; an entry whose command holds none of them is not kit's. */
const KIT_HOOK_SUBCOMMANDS = [...GATE_SUBCOMMANDS, "hooks context"];

export interface PlanOptions {
  /** The project directory (the home directory's settings with `user`). */
  cwd: string;
  /** The home directory, for `--user`. */
  home: string;
  user: boolean;
  installGate: boolean;
  brokerGate: boolean;
  limitsGate: boolean;
}

export interface Invariant {
  ok: boolean;
  detail: string;
}

export interface PlannedFile {
  /** The path as shown and hashed: relative to the project, or `~/` for the user file. */
  path: string;
  before: string | null;
  after: string | null;
  owned: string[];
  invariants: [Invariant, Invariant];
}

export interface AgentConfigPlan {
  files: PlannedFile[];
  hash: string;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textOf(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function parsed(text: string | null): { ok: true; doc: Json } | { ok: false } {
  if (text === null) return { ok: true, doc: {} };
  try {
    const doc: unknown = JSON.parse(text);
    return isObject(doc) ? { ok: true, doc } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** JSON with sorted keys, so key order does not count as a change. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (!isObject(v)) return JSON.stringify(v) ?? "null";
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

/** Delete one dotted path, then drop the containers on it that the deletion left empty. */
function deletePath(doc: Json, dotted: string): void {
  const keys = dotted.split(".");
  const chain: Json[] = [doc];
  for (const key of keys.slice(0, -1)) {
    const next = chain[chain.length - 1][key];
    if (!isObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][keys[keys.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) return;
    delete chain[i - 1][keys[i - 1]];
  }
}

function outsideHooks(doc: Json, owned: string[]): string {
  const copy = structuredClone(doc);
  delete copy.hooks;
  for (const path of owned) deletePath(copy, path);
  return canonical(copy);
}

function isKitCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return KIT_HOOK_SUBCOMMANDS.some((sub) =>
    sub.includes(" ") ? command.includes(sub) : commandIncludesSubcommand(command, sub),
  );
}

/** Each event's hook entries that are not kit's, in order, as canonical strings. */
function foreignHooks(doc: Json): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!isObject(doc.hooks)) return out;
  for (const [event, groups] of Object.entries(doc.hooks)) {
    const entries: string[] = [];
    for (const group of Array.isArray(groups) ? groups : [groups]) {
      const hooks: unknown[] = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      if (!isObject(group) || !Array.isArray(group.hooks)) entries.push(canonical(group));
      for (const hook of hooks) {
        if (isObject(hook) && isKitCommand(hook.command)) continue;
        entries.push(canonical({ matcher: isObject(group) ? group.matcher : undefined, hook }));
      }
    }
    out.set(event, entries);
  }
  return out;
}

/** The two invariants for one file. */
export function checkInvariants(
  before: string | null,
  after: string | null,
  owned: string[],
): [Invariant, Invariant] {
  const allowed = owned.length > 0 ? ` (allowed: ${owned.join(", ")})` : "";
  const a = parsed(before);
  const b = parsed(after);
  if (!a.ok || !b.ok) {
    const ok = before === after;
    const detail = ok
      ? "the file is not a JSON object and is left as it is"
      : "the file is not a JSON object; agent-config would replace it";
    return [
      { ok, detail },
      { ok, detail },
    ];
  }
  const sameOutside = outsideHooks(a.doc, owned) === outsideHooks(b.doc, owned);
  const first = {
    ok: sameOutside,
    detail: `nothing outside "hooks" changes, except kit's own keys${allowed}`,
  };
  const was = foreignHooks(a.doc);
  const now = foreignHooks(b.doc);
  const lost = [...was].filter(
    ([event, list]) => canonical(now.get(event) ?? []) !== canonical(list),
  );
  const count = [...was.values()].reduce((n, list) => n + list.length, 0);
  const second = {
    ok: lost.length === 0,
    detail:
      lost.length === 0
        ? `${count} hook entr${count === 1 ? "y" : "ies"} not kit's, all kept in the same order`
        : `hook entries not kit's changed or moved under: ${lost.map(([e]) => e).join(", ")}`,
  };
  return [first, second];
}

/** sha256 over each file's path and planned content, in path order. */
export function planHash(files: { path: string; after: string | null }[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
    hash.update(`${f.path}\0${f.after === null ? "\u0001absent" : f.after}\0`);
  }
  return hash.digest("hex");
}

/**
 * Copy the real files into the mirror. When the real `.claude/settings.json` is tracked by git,
 * track the copy too, so `gateSettingsFile` picks `settings.local.json` in the mirror as well.
 */
async function mirror(real: string, copy: string, rels: string[]): Promise<void> {
  mkdirSync(copy, { recursive: true });
  if (existsSync(join(real, ".claude"))) mkdirSync(join(copy, ".claude"), { recursive: true });
  for (const rel of rels) {
    if (!existsSync(join(real, rel))) continue;
    mkdirSync(dirname(join(copy, rel)), { recursive: true });
    copyFileSync(join(real, rel), join(copy, rel));
  }
  if ((await gateSettingsFile(real)) === SHARED) return;
  await execFileNoThrow("git", ["init", "-q"], { cwd: copy, timeout: 10_000 });
  await execFileNoThrow("git", ["add", "--", SHARED], { cwd: copy, timeout: 10_000 });
}

/** The project writers, in the order cmdAgentConfig and its entry run them. */
async function runProjectWriters(copy: string, opts: PlanOptions): Promise<void> {
  await installStrictSettings(copy);
  await installKitPermissions(copy);
  if (opts.installGate) {
    await installInstallGate(copy);
    await installEnvWriteGate(copy);
    await installSessionStartCheck(copy);
  }
  if (opts.brokerGate) await installBrokerGates(copy);
  if (opts.limitsGate) await installLimitsGate(copy);
}

/**
 * A gate command names `$HOME/.kit/bin/kit` only when that wrapper exists, and agent-config
 * writes the wrapper before the gates. When it is missing now and the real run would write it,
 * the writers run with HOME pointed at a directory holding a stand-in, so the plan shows the
 * command the real run writes. Windows hooks do not use the wrapper.
 */
async function withPredictedWrapper<T>(
  scratch: string,
  opts: PlanOptions,
  run: () => Promise<T>,
): Promise<T> {
  const ensures = (opts.user || opts.installGate) && !isReadOnlyMode();
  if (process.platform === "win32" || !ensures || existsSync(kitWrapperPath())) return run();
  const fakeHome = join(scratch, "wrapper-home");
  mkdirSync(dirname(kitWrapperPath(fakeHome)), { recursive: true });
  await writeFile(kitWrapperPath(fakeHome), "");
  const saved = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

async function planProject(scratch: string, opts: PlanOptions): Promise<PlannedFile[]> {
  const gateFile = await gateSettingsFile(opts.cwd);
  const rels = [...new Set([SHARED, gateFile])].sort();
  const copy = join(scratch, "project");
  await mirror(opts.cwd, copy, rels);
  // agent-config writes CLAUDE.md first when it teaches Claude Code, which makes this a Claude
  // Code project for the settings writers even without a `.claude/` directory.
  const claude = detectAgentTargets(opts.cwd).some((t) => t.file === "CLAUDE.md");
  if (claude || existsSync(join(opts.cwd, "CLAUDE.md")))
    await writeFile(join(copy, "CLAUDE.md"), "");
  await withPredictedWrapper(scratch, opts, () => runProjectWriters(copy, opts));
  return rels.map((rel) =>
    planned(rel, textOf(join(opts.cwd, rel)), textOf(join(copy, rel)), rel === SHARED),
  );
}

async function planUser(scratch: string, opts: PlanOptions): Promise<PlannedFile[]> {
  const copy = join(scratch, "home");
  await mirror(opts.home, copy, [SHARED]);
  await withPredictedWrapper(scratch, opts, () => installUserGates(copy));
  return [
    planned("~/" + SHARED, textOf(join(opts.home, SHARED)), textOf(join(copy, SHARED)), false),
  ];
}

function planned(
  path: string,
  before: string | null,
  after: string | null,
  shared: boolean,
): PlannedFile {
  const owned = shared ? OWNED_OUTSIDE_HOOKS : [];
  return { path, before, after, owned, invariants: checkInvariants(before, after, owned) };
}

/** Compute the plan. Writes only inside a temporary directory, which it removes. */
export async function computeAgentConfigPlan(opts: PlanOptions): Promise<AgentConfigPlan> {
  const scratch = mkdtempSync(join(tmpdir(), "kit-agent-config-plan-"));
  try {
    const files = opts.user ? await planUser(scratch, opts) : await planProject(scratch, opts);
    return { files, hash: planHash(files) };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

function linesOf(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line operations from a longest-common-subsequence table; deletions before insertions. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i++] });
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ kind: "-", text: a[i++] });
    } else {
      ops.push({ kind: "+", text: b[j++] });
    }
  }
  return ops;
}

/** Index ranges of `ops` to print: each change with `context` lines around it, merged. */
function hunkRanges(ops: DiffOp[], context: number): [number, number][] {
  const ranges: [number, number][] = [];
  ops.forEach((op, k) => {
    if (op.kind === " ") return;
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length, k + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  return ranges;
}

/** The `@@` header of one hunk, from the 1-based line its first op has in either file. */
function hunkHeader(slice: DiffOp[], oldFirst: number, newFirst: number): string {
  const oldLen = slice.filter((op) => op.kind !== "+").length;
  const newLen = slice.filter((op) => op.kind !== "-").length;
  const oldStart = oldLen === 0 ? oldFirst - 1 : oldFirst;
  const newStart = newLen === 0 ? newFirst - 1 : newFirst;
  return `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`;
}

/** A unified-style line diff of one file, or [] when nothing changes. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string[] {
  const ops = diffOps(linesOf(before), linesOf(after));
  const ranges = hunkRanges(ops, 3);
  if (ranges.length === 0) return [];
  const out = [
    before === null ? "--- /dev/null" : `--- a/${path}`,
    after === null ? "+++ /dev/null" : `+++ b/${path}`,
  ];
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") n++;
  }
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end);
    out.push(hunkHeader(slice, oldAt[start], newAt[start]));
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out;
}

/** The plan as printed lines: per file its diff and two invariants, then `note`, the hash last. */
export function describePlan(plan: AgentConfigPlan, note?: string): string[] {
  const lines: string[] = [];
  for (const f of plan.files) {
    const diff = unifiedDiff(f.path, f.before, f.after);
    lines.push(...(diff.length > 0 ? diff : [`= ${f.path}: no changes`]));
    f.invariants.forEach((inv, k) => {
      lines.push(`  invariant ${k + 1} ${inv.ok ? "holds" : "VIOLATED"}: ${inv.detail}`);
    });
    lines.push("");
  }
  if (note) lines.push(note);
  lines.push(`plan hash: ${plan.hash}`);
  return lines;
}

/** What the flags ask agent-config to write, read the way cmdAgentConfigEntry reads them. */
export function planOptionsFrom(argv: readonly string[]): PlanOptions {
  return {
    cwd: process.cwd(),
    home: homedir(),
    user: hasFlag(argv, "--user"),
    installGate: !hasFlag(argv, "--no-install-gate"),
    brokerGate: hasFlag(argv, "--broker-gate"),
    limitsGate: hasFlag(argv, "--limits-gate"),
  };
}

export type PlanStep = "continue" | "done" | "failed";

const STALE = "the settings changed since the plan; run kit agent-config --plan again";

async function planOnly(argv: readonly string[]): Promise<PlanStep> {
  const plan = await computeAgentConfigPlan(planOptionsFrom(argv));
  const flags = argv.slice(3).filter((a) => a !== "--plan");
  const apply = ["kit agent-config", ...flags, "--apply", plan.hash].join(" ");
  console.log("kit agent-config --plan: nothing was written\n");
  for (const line of describePlan(plan, `Write exactly this plan: ${apply}`)) console.log(line);
  return plan.files.every((f) => f.invariants.every((i) => i.ok)) ? "done" : "failed";
}

async function applyChecked(argv: readonly string[]): Promise<PlanStep> {
  const wanted = flagValue(argv, "--apply");
  if (!wanted || wanted.startsWith("-")) {
    console.error("--apply needs the hash that kit agent-config --plan printed");
    return "failed";
  }
  const plan = await computeAgentConfigPlan(planOptionsFrom(argv));
  if (plan.hash !== wanted.trim().toLowerCase()) {
    console.error(`${STALE} (planned ${wanted}, now ${plan.hash}). Nothing was written.`);
    return "failed";
  }
  for (const line of describePlan(plan)) console.log(line);
  console.log("");
  return "continue";
}

/** The default run prints the plan before writing, unless non-interactive. A failed plan never blocks it. */
async function preview(argv: readonly string[]): Promise<PlanStep> {
  if (isNonInteractive()) return "continue";
  try {
    const plan = await computeAgentConfigPlan(planOptionsFrom(argv));
    for (const line of describePlan(plan)) console.log(line);
    console.log("");
  } catch {
    // The preview is advisory: agent-config writes as it always has.
  }
  return "continue";
}

/**
 * Run before agent-config writes anything. `--plan` prints the plan and stops; `--apply <hash>`
 * stops unless the plan computed now has that hash; otherwise the plan is printed and the run goes on.
 */
export async function agentConfigPlanStep(
  argv: readonly string[] = process.argv,
): Promise<PlanStep> {
  const applying = argv.some((a) => a === "--apply" || a.startsWith("--apply="));
  if (hasFlag(argv, "--plan") && applying) {
    console.error("--plan and --apply cannot be used together");
    return "failed";
  }
  if (hasFlag(argv, "--plan")) return planOnly(argv);
  return applying ? applyChecked(argv) : preview(argv);
}
