#!/usr/bin/env node
/**
 * Phase 0 of the scope-tripwire plan (docs/plans/2026-11-06-scope-tripwires.md): measure, on the
 * agent transcripts already on this machine, how often ordinary agent work would touch a decoy
 * before any decoy exists. Read-only. It prints counts, never transcript content, unless
 * `--examples` is given, and then only the first 100 characters of each matching call with
 * anything secret-shaped masked.
 *
 *   node scripts/tripwire-baseline.mjs [dir ...] [--examples] [--json]
 *
 * Default directories: ~/.claude/projects and ~/.codex/sessions. Every *.jsonl below them is read.
 * A tool call is any JSON object with a `name` and an `input` object (Claude Code) or an
 * `arguments` string (Codex). Only the fields a gate would judge are classified: the path read,
 * the command run, the pattern listed. The content of a Write or a PR body is not a touch.
 *
 * Categories (one call can fall in several):
 *   decoy-named    the call names one of the planned decoys: the false-positive floor of the
 *                  explicit rule (expected 0 before decoys exist; anything else is a name clash)
 *   sweep          a command that would READ a decoy placed beside real secrets without naming
 *                  it: env globs (`.env*`), recursive grep/find -exec cat, archives and copies of
 *                  a whole tree, `~/.ssh/*`. These are the explicit rule's blind spots and the broad
 *                  rule's false positives.
 *   secret-class   the call names a real secret-class file (.env, .env.local, ~/.ssh/id_*,
 *                  .aws/credentials, .netrc, .npmrc): how often legitimate work is already in the
 *                  neighbourhood a decoy would sit in
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DECOYS = [".env.canary", "id_canary", "KIT_CANARY_TOKEN", "canary-credentials.json"];

const SWEEP = [
  /\.env\*|\.env\.\*|\.env\{|\.env\[/,
  /\b(grep|egrep|fgrep)\b\s+-[a-zA-Z]*[rR][^|;&\n]*\s(\.|\.\/|~|~\/|\$HOME)(?=\s|$|\\?")/,
  /\brg\b[^|;&\n]*(--hidden|-uu|--no-ignore)/,
  /\bfind\b[^|;&\n]*(-exec\s+(cat|head|tail|less|strings)|\|\s*xargs\s+(cat|head|grep))/,
  /\b(tar|zip|7z)\b[^|;&\n]*\s(\.|\.\/|~|\$HOME)(\s|$)/,
  /\b(cp|rsync|scp)\b[^|;&\n]*\s-[a-zA-Z]*[ra][^|;&\n]*\s(\.|\.\/|~|\$HOME)(\/)?(\s|$)/,
  /~\/\.ssh\/\*|\$HOME\/\.ssh\/\*|\.ssh\/\*/,
];
const SECRET_CLASS = [
  /(^|[\s"'`/=])\.env(\.local|\.production|\.development)?(?=$|[\s"'`;|&)])/,
  /\.ssh\/id_[a-z0-9]+/,
  /\.aws\/credentials/,
  /(^|[\s"'`/])\.netrc\b/,
  /(^|[\s"'`/])\.npmrc\b/,
];

const TARGET_KEYS = ["file_path", "path", "command", "cmd", "pattern", "glob"];

/** The fields a gate would judge (what is read, run or listed), never written content. Pure. */
export function targetOf(input) {
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return input;
    }
  }
  if (!obj || typeof obj !== "object") return String(input);
  return TARGET_KEYS.filter((k) => k in obj)
    .map((k) => (typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k])))
    .join("\n");
}

/** The tool calls in one parsed JSON value, as `{ name, text }`. Pure. */
export function toolCalls(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) toolCalls(v, out);
  } else if (value && typeof value === "object") {
    if (typeof value.name === "string") {
      if (value.input && typeof value.input === "object")
        out.push({ name: value.name, text: targetOf(value.input) });
      else if (typeof value.arguments === "string")
        out.push({ name: value.name, text: targetOf(value.arguments) });
    }
    for (const v of Object.values(value)) if (v && typeof v === "object") toolCalls(v, out);
  }
  return out;
}

/** The categories one tool call's text falls in. Pure. */
export function classify(text) {
  const cats = [];
  if (DECOYS.some((d) => text.includes(d))) cats.push("decoy-named");
  if (SWEEP.some((r) => r.test(text))) cats.push("sweep");
  if (SECRET_CLASS.some((r) => r.test(text))) cats.push("secret-class");
  return cats;
}

function mask(text) {
  return text
    .replace(/(sk-|ghp_|gho_|github_pat_|xox[bp]-|AKIA)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/([A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=)[^\s"']+/gi, "$1***")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function* jsonlFiles(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 6) yield* jsonlFiles(p, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

function* fileCalls(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    yield* toolCalls(parsed);
  }
}

export function baseline(dirs) {
  const counts = { files: 0, calls: 0, "decoy-named": 0, sweep: 0, "secret-class": 0 };
  const byTool = {};
  const examples = { "decoy-named": [], sweep: [], "secret-class": [] };
  const files = dirs.flatMap((d) => [...jsonlFiles(d)]);
  for (const file of files) {
    if (statSync(file).size > 512 * 1024 * 1024) continue;
    counts.files++;
    for (const call of fileCalls(file)) {
      counts.calls++;
      for (const cat of classify(call.text)) {
        counts[cat]++;
        byTool[`${cat}:${call.name}`] = (byTool[`${cat}:${call.name}`] ?? 0) + 1;
        if (examples[cat].length < 5) examples[cat].push(`${call.name}: ${mask(call.text)}`);
      }
    }
  }
  return { counts, byTool, examples };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dirs = args.filter((a) => !a.startsWith("--"));
  const home = homedir();
  const r = baseline(
    dirs.length ? dirs : [join(home, ".claude", "projects"), join(home, ".codex", "sessions")],
  );
  if (args.includes("--json")) {
    const { examples, ...rest } = r;
    console.log(JSON.stringify(args.includes("--examples") ? r : rest, null, 2));
  } else {
    console.log(`transcript files read: ${r.counts.files}, tool calls: ${r.counts.calls}`);
    for (const cat of ["decoy-named", "sweep", "secret-class"])
      console.log(`${cat.padEnd(13)} ${r.counts[cat]}`);
    console.log("by tool:", JSON.stringify(r.byTool));
    if (args.includes("--examples"))
      for (const [cat, xs] of Object.entries(r.examples))
        xs.forEach((x) => console.log(`  [${cat}] ${x}`));
  }
}
