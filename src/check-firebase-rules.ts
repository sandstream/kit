/**
 * Firebase security rules, read statically: `kit check` row `firebase security rules`.
 *
 * Firestore and Cloud Storage decide who reads and writes in a rules file that ships with the
 * app. The common hole in a fast-built app is a rule left open: `allow read, write: if true;`, or
 * an `allow` with no condition, which grants the methods to anyone holding the public config. A
 * quieter one is `if request.auth != null` on a wildcard match, which lets every signed-in user
 * read every document.
 *
 * Files read: `firestore.rules` and `storage.rules` at the project root, and every `rules` path
 * that `firebase.json` names under `firestore` or `storage` (object or array form). A named path
 * outside the project is not read. Only the project root is looked at; Realtime Database rules
 * (`database.rules.json`) are not read. The parser and its limits are in `firebase-rules-parse.ts`.
 */

import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { SecurityCheckResult } from "./check-security.js";
import {
  documentSegments,
  isOpenCondition,
  isSignedInOnly,
  isWildcardMatch,
  parseRules,
  type AllowRule,
} from "./firebase-rules-parse.js";

const NAME = "firebase security rules";
const BASE = { category: "exposure", name: NAME } as const;
const MAX_RULES_BYTES = 1024 * 1024;
const DEFAULT_FILES = ["firestore.rules", "storage.rules"];
const WRITE_METHODS = new Set(["write", "create", "update", "delete"]);

interface RulesFile {
  file: string;
  text: string;
}

interface Located {
  files: string[];
  /** Notes on firebase.json: unparseable, or a named path outside the project. */
  notes: string[];
}

/** The `rules` paths of one `firestore` or `storage` entry, in object or array form. */
function rulesPaths(entry: unknown): string[] {
  const list = Array.isArray(entry) ? entry : [entry];
  return list
    .map((e) => (e && typeof e === "object" ? (e as { rules?: unknown }).rules : undefined))
    .filter((r): r is string => typeof r === "string" && r.length > 0);
}

/** A path from firebase.json, relative to the root; null when it leaves the project. */
function insideRoot(root: string, named: string): string | null {
  const rel = relative(root, resolve(root, named));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return normalize(rel);
}

async function namedByFirebaseJson(root: string, notes: string[]): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, "firebase.json"), "utf8");
  } catch {
    return [];
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    notes.push("firebase.json is not valid JSON, so the rules files it names were not read");
    return [];
  }
  const named = [...rulesPaths(config?.firestore), ...rulesPaths(config?.storage)];
  const out: string[] = [];
  for (const n of named) {
    const rel = insideRoot(root, n);
    if (rel === null) notes.push(`firebase.json names ${n}, outside the project; not read`);
    else out.push(rel);
  }
  return out;
}

export async function locateRulesFiles(root: string): Promise<Located> {
  const notes: string[] = [];
  const named = await namedByFirebaseJson(root, notes);
  // Windows and (usually) macOS file names are case-insensitive: one file, one read.
  const key = (f: string): string => (process.platform === "linux" ? f : f.toLowerCase());
  const byKey = new Map<string, string>();
  for (const f of [...DEFAULT_FILES.map(normalize), ...named])
    if (!byKey.has(key(f))) byKey.set(key(f), f);
  return { files: [...byKey.values()], notes };
}

async function readRulesFile(full: string): Promise<string | "missing" | "oversize"> {
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return "missing";
    if (info.size > MAX_RULES_BYTES) return "oversize";
    return await handle.readFile("utf8");
  } catch {
    return "missing";
  } finally {
    await handle?.close();
  }
}

/** The match path as a reader knows it, below the service root. */
function shortPath(path: string): string {
  return `/${documentSegments(path).join("/")}`;
}

function describe(file: string, a: AllowRule): string {
  const cond = a.condition === null ? "with no condition" : `if ${a.condition}`;
  return `${file}:${a.line} allow ${a.methods.join(", ")} ${cond} on ${shortPath(a.path)}`;
}

interface RulesFindings {
  open: string[];
  signedIn: string[];
  opensWrite: boolean;
  incomplete: string[];
}

function evaluateRules(sources: RulesFile[]): RulesFindings {
  const found: RulesFindings = { open: [], signedIn: [], opensWrite: false, incomplete: [] };
  for (const { file, text } of sources) {
    const parsed = parseRules(text);
    if (parsed.incomplete) found.incomplete.push(`${file} (${parsed.incomplete})`);
    for (const a of parsed.allows) {
      if (isOpenCondition(a.condition)) {
        found.open.push(describe(file, a));
        found.opensWrite ||= a.methods.some((m) => WRITE_METHODS.has(m));
      } else if (isSignedInOnly(a.condition) && isWildcardMatch(a.path)) {
        found.signedIn.push(describe(file, a));
      }
    }
  }
  return found;
}

const OPEN_FIX =
  "Replace `if true` and condition-less `allow` statements with a condition on the caller, such as `request.auth.uid == userId`, scoped to the document's owner. Run `kit check --category security` again after the change.";
const SIGNED_IN_FIX =
  "`request.auth != null` on a wildcard match lets every signed-in user read every document. Match each collection by name and compare `request.auth.uid` with the document's owner.";
const LIMITS =
  "conditions are compared as text; functions and `||` are not evaluated, and an empty list is not proof the rules are safe";

function verdict(found: RulesFindings, count: string): SecurityCheckResult {
  if (found.open.length) {
    const also = found.signedIn.length ? `; signed-in only: ${found.signedIn.join("; ")}` : "";
    return {
      ...BASE,
      status: "fail",
      severity: found.opensWrite ? "critical" : "high",
      hasFindings: true,
      detail: `${found.open.length} rule(s) open to everyone in ${count}: ${found.open.join("; ")}${also}`,
      suggestion: OPEN_FIX,
    };
  }
  if (found.signedIn.length) {
    return {
      ...BASE,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${found.signedIn.length} wildcard rule(s) need only a signed-in user in ${count}: ${found.signedIn.join("; ")}`,
      suggestion: SIGNED_IN_FIX,
    };
  }
  return {
    ...BASE,
    status: "pass",
    detail: `no open or signed-in-only wildcard rule in ${count} (${LIMITS})`,
  };
}

/** Notes and unread files make the row incomplete: a pass becomes a did-not-run warning. */
function withNotes(result: SecurityCheckResult, notes: string[]): SecurityCheckResult {
  if (notes.length === 0) return result;
  const note = `scan incomplete: ${notes.join("; ")}`;
  if (result.status === "fail") {
    return { ...result, detail: `${result.detail}; ${note}`, scanIncomplete: true };
  }
  const detail = result.status === "pass" ? note : `${result.detail}; ${note}`;
  return { ...result, status: "warn", didNotRun: true, scanIncomplete: true, detail };
}

async function readAll(
  root: string,
  files: string[],
  notes: string[],
): Promise<{ sources: RulesFile[]; missingNamed: string[] }> {
  const sources: RulesFile[] = [];
  const missingNamed: string[] = [];
  for (const file of files) {
    const read = await readRulesFile(join(root, file));
    if (read === "oversize") notes.push(`${file} is larger than ${MAX_RULES_BYTES} bytes`);
    else if (read === "missing") missingNamed.push(file);
    else sources.push({ file, text: read });
  }
  return { sources, missingNamed };
}

export async function checkFirebaseRules(root: string): Promise<SecurityCheckResult> {
  const { files, notes } = await locateRulesFiles(root);
  const { sources, missingNamed } = await readAll(root, files, notes);
  // A default name that is absent is normal; a path firebase.json names and that is absent is not.
  const named = new Set(files.filter((f) => !DEFAULT_FILES.includes(f)));
  for (const f of missingNamed) if (named.has(f)) notes.push(`firebase.json names ${f}, not found`);
  if (sources.length === 0 && notes.length === 0) {
    return {
      ...BASE,
      status: "skip",
      detail:
        "no Firebase rules files (firestore.rules, storage.rules, or rules named by firebase.json), nothing to read",
    };
  }
  const found = evaluateRules(sources);
  const count = `${sources.length} rules file${sources.length === 1 ? "" : "s"}`;
  const incomplete = found.incomplete.map((f) => `could not finish reading ${f}`);
  return withNotes(verdict(found, count), [...notes, ...incomplete]);
}
