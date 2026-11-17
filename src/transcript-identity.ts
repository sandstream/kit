/**
 * Which agent tool calls in the local Claude Code transcripts carried one of the user's own
 * identities, and whether those calls went to the network.
 *
 * Claude Code once put the signed-in account's address into requests that agents wrote
 * (kit-research `claude-code-account-email-user-agent-vs-kit`), and agents also read git's
 * author name and address from `git log`. This scan answers "did any of that leave the machine
 * through a tool call?" from the transcripts already on disk.
 *
 *   - Identities: the effective git `user.email` and `user.name`, and the Claude Code account
 *     address (`oauthAccount.emailAddress` in `~/.claude.json`, or `$CLAUDE_CONFIG_DIR`).
 *   - Transcripts: `*.jsonl` under `~/.claude/projects` (and `$CLAUDE_CONFIG_DIR/projects`),
 *     bounded by file count, file size and depth, read line by line as a stream.
 *
 * Offline and read-only. The result holds counts by identity kind, tool and destination host,
 * never an identity value.
 */
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { classifyToolCall } from "./transcript-identity-classify.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export type IdentityKind = "git-email" | "git-name" | "account-email";

export interface Identity {
  kind: IdentityKind;
  value: string;
}

export interface ScanLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxFiles: 5000,
  maxFileBytes: 64 * 1024 * 1024,
  maxDepth: 4,
};

interface Tally {
  hits: number;
  network: number;
}

export interface IdentityScan {
  /** The kinds the scan looked for; values are never kept. */
  identities: IdentityKind[];
  filesScanned: number;
  /** Files left out: over the size cap, or unreadable. */
  filesSkipped: number;
  /** True when more transcripts exist than the file-count cap lets the scan read. */
  fileCapReached: boolean;
  toolCalls: number;
  hits: number;
  networkHits: number;
  byKind: Record<string, Tally>;
  byTool: Record<string, Tally>;
  byHost: Record<string, number>;
}

/** Shorter values match too much unrelated text to mean anything. */
const MIN_LENGTH: Record<IdentityKind, number> = {
  "git-email": 5,
  "account-email": 5,
  "git-name": 4,
};

/** `~/.claude.json` grows with history; anything larger than this is not read. */
const MAX_CONFIG_BYTES = 64 * 1024 * 1024;

async function gitConfig(cwd: string, key: string, env: NodeJS.ProcessEnv): Promise<string> {
  const r = await execFileNoThrow("git", ["config", "--get", key], { cwd, env, timeout: 10_000 });
  return r.ok ? r.stdout.trim() : "";
}

function claudeDir(env: NodeJS.ProcessEnv): string | null {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? dir : null;
}

async function accountEmail(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const file = join(claudeDir(env) ?? home, ".claude.json");
  try {
    // One handle for the size check and the read: no check-then-use on the path (CodeQL file race).
    const fh = await open(file, "r");
    let text: string;
    try {
      if ((await fh.stat()).size > MAX_CONFIG_BYTES) return "";
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
    const parsed = JSON.parse(text) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const v = parsed?.oauthAccount?.emailAddress;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

/** The identities to look for: effective git config in `cwd`, then the Claude Code account. */
export async function identitySet(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Identity[]> {
  const found: Identity[] = [
    { kind: "git-email", value: await gitConfig(cwd, "user.email", env) },
    { kind: "git-name", value: await gitConfig(cwd, "user.name", env) },
    { kind: "account-email", value: await accountEmail(home, env) },
  ];
  return found.filter((i) => i.value.length >= MIN_LENGTH[i.kind]);
}

/** Directories that hold Claude Code project transcripts. */
export function transcriptRoots(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [join(home, ".claude", "projects")];
  const dir = claudeDir(env);
  if (dir && join(dir, "projects") !== roots[0]) roots.push(join(dir, "projects"));
  return roots;
}

async function collectJsonl(dir: string, depth: number, max: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length > max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await collectJsonl(full, depth - 1, max, out);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
    if (out.length > max) return;
  }
}

function matches(inputText: string, id: Identity): boolean {
  if (id.kind === "git-name") return inputText.includes(id.value);
  return inputText.toLowerCase().includes(id.value.toLowerCase());
}

function bump(map: Record<string, Tally>, key: string, network: boolean): void {
  const t = (map[key] ??= { hits: 0, network: 0 });
  t.hits++;
  if (network) t.network++;
}

/** The `tool_use` blocks of one transcript line, as name and input. */
function toolUses(line: string): { name: string; input: unknown }[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const content = (obj as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_use")
    .map((b) => {
      const name = (b as { name?: unknown }).name;
      return { name: typeof name === "string" ? name.slice(0, 120) : "unknown", input: b.input };
    });
}

function recordLine(line: string, ids: Identity[], scan: IdentityScan): void {
  for (const call of toolUses(line)) {
    scan.toolCalls++;
    const inputText = JSON.stringify(call.input ?? {});
    const kinds = ids.filter((id) => matches(inputText, id)).map((id) => id.kind);
    if (kinds.length === 0) continue;
    const { network, host } = classifyToolCall(call.name, inputText);
    scan.hits++;
    if (network) scan.networkHits++;
    for (const k of new Set(kinds)) bump(scan.byKind, k, network);
    bump(scan.byTool, call.name, network);
    if (network && host) scan.byHost[host] = (scan.byHost[host] ?? 0) + 1;
  }
}

async function scanFile(
  file: string,
  ids: Identity[],
  scan: IdentityScan,
  max: number,
): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Size check and read through one handle: no check-then-use on the path (CodeQL file race).
    fh = await open(file, "r");
    if ((await fh.stat()).size > max) {
      scan.filesSkipped++;
      return;
    }
    const needles = ids.map((i) => i.value.toLowerCase());
    const input = fh.createReadStream({ autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"tool_use"')) continue;
      const lower = line.toLowerCase();
      if (needles.some((n) => lower.includes(n))) recordLine(line, ids, scan);
    }
    scan.filesScanned++;
  } catch {
    scan.filesSkipped++;
  } finally {
    await fh?.close();
  }
}

/** Scan every transcript under `roots` for tool calls that carry one of `ids`. */
export async function scanTranscriptIdentity(
  ids: Identity[],
  roots: string[],
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<IdentityScan> {
  const scan: IdentityScan = {
    identities: [...new Set(ids.map((i) => i.kind))],
    filesScanned: 0,
    filesSkipped: 0,
    fileCapReached: false,
    toolCalls: 0,
    hits: 0,
    networkHits: 0,
    byKind: {},
    byTool: {},
    byHost: {},
  };
  const files: string[] = [];
  for (const root of roots) await collectJsonl(root, limits.maxDepth, limits.maxFiles, files);
  scan.fileCapReached = files.length > limits.maxFiles;
  if (ids.length === 0) return scan;
  for (const file of files.slice(0, limits.maxFiles)) {
    await scanFile(file, ids, scan, limits.maxFileBytes);
  }
  return scan;
}
