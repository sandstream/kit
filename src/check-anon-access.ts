/**
 * Anonymous database access, read statically from SQL migrations.
 *
 * A policy such as `FOR SELECT USING (true)` lets anyone with the public anon key read every row
 * of a table. The migration reads like ordinary public-content setup, so the exposure is easy to
 * miss, above all when the table also holds a phone number or an email address.
 *
 * Static first: this reads `CREATE POLICY`, `GRANT` and `REVOKE` statements in file name order and
 * lists each table that anonymous readers can select from. A live check against a database needs a
 * read-only role and is deferred. Out of scope here: `ALTER DEFAULT PRIVILEGES`, roles other than
 * anon and public, and policies created outside the SQL files in the repository.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { SecurityCheckResult } from "./check-security.js";

export const ANON_ACCESS_CHECK = "anonymous database access";

const MAX_SQL_BYTES = 2 * 1024 * 1024;
const MAX_SQL_FILES = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".worktrees"]);

export interface SqlSource {
  file: string;
  text: string;
}

export interface ReadableTable {
  table: string;
  /** Column names that look personal (phone, email, person name, national id). */
  personalColumns: string[];
  /** The statements that open the table, for the report. */
  via: string[];
}

export interface AnonAnalysis {
  readable: ReadableTable[];
  /** Files with an unterminated quote, comment or dollar quote, which may hide statements. */
  incomplete: string[];
}

const PERSONAL_COLUMN =
  /(^|_)(phone|mobile|telephone|tel|email|e_?mail|ssn|personnummer|national_?id|birth_?date|dob)(_|$)|(first|last|full|sur|customer|guest|contact|person)_?name$/;

const ANON_ROLES = new Set(["anon", "public"]);

const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const LINE_COMMENT = String.fromCharCode(45, 45);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

/** What a lexer step consumed: the index after it and the text it leaves behind. */
type Skip = { end: number; keep: string; unterminated?: true };

function skipLineComment(text: string, i: number): Skip | null {
  if (!text.startsWith(LINE_COMMENT, i)) return null;
  const nl = text.indexOf("\n", i);
  return { end: nl === -1 ? text.length : nl, keep: " " };
}

function skipBlockComment(text: string, i: number): Skip | null {
  if (!text.startsWith(BLOCK_OPEN, i)) return null;
  let depth = 0;
  let at = i;
  while (at < text.length) {
    if (text.startsWith(BLOCK_OPEN, at)) {
      depth++;
      at += 2;
    } else if (text.startsWith(BLOCK_CLOSE, at)) {
      depth--;
      at += 2;
      if (depth === 0) return { end: at, keep: " " };
    } else {
      at++;
    }
  }
  return { end: text.length, keep: " ", unterminated: true };
}

function isIdentChar(ch: string | undefined): boolean {
  return ch === "$" || isTagChar(ch, false);
}

/** An E string (a lone E or e right before the quote) treats a backslash as an escape. */
function isEscapeString(text: string, i: number): boolean {
  const before = text[i - 1];
  return (before === "E" || before === "e") && !isIdentChar(text[i - 2]);
}

/** A quoted run, with a doubled quote as the escape. A string loses its content, an identifier keeps it. */
function skipQuoted(text: string, i: number, quote: string): Skip | null {
  if (text[i] !== quote) return null;
  const backslash = quote === SQ && isEscapeString(text, i);
  let at = i + 1;
  while (at < text.length) {
    if (backslash && text[at] === "\\") at += 2;
    else if (text[at] === quote && text[at + 1] === quote) at += 2;
    else if (text[at] === quote) break;
    else at++;
  }
  const closed = at < text.length;
  const end = Math.min(at + 1, text.length);
  const keep = quote === SQ ? SQ + SQ : text.slice(i, end);
  return closed ? { end, keep } : { end, keep, unterminated: true };
}

function isTagChar(ch: string | undefined, first: boolean): boolean {
  if (ch === undefined) return false;
  const letter = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  return letter || (!first && ch >= "0" && ch <= "9");
}

/** The opening tag at i, such as the two dollar signs or a named tag, or null when none starts here. */
function dollarTagAt(text: string, i: number): string | null {
  let at = i + 1;
  while (isTagChar(text[at], at === i + 1)) at++;
  return text[at] === "$" ? text.slice(i, at + 1) : null;
}

function skipDollarQuote(text: string, i: number): Skip | null {
  if (text[i] !== "$" || isIdentChar(text[i - 1])) return null;
  const tag = dollarTagAt(text, i);
  if (!tag) return null;
  const close = text.indexOf(tag, i + tag.length);
  if (close === -1) return { end: text.length, keep: " ", unterminated: true };
  return { end: close + tag.length, keep: " " };
}

function skipSpecial(text: string, i: number): Skip | null {
  return (
    skipLineComment(text, i) ??
    skipBlockComment(text, i) ??
    skipQuoted(text, i, SQ) ??
    skipQuoted(text, i, DQ) ??
    skipDollarQuote(text, i)
  );
}

/**
 * Split SQL into statements in one pass. Comments, string contents and dollar-quoted bodies are
 * recognised only where they can start, so a dollar sign or comment opener inside another
 * construct cannot hide the statements that follow it.
 */
export function splitStatements(text: string): { statements: string[]; unterminated: boolean } {
  const statements: string[] = [];
  let current = "";
  let unterminated = false;
  let i = 0;
  while (i < text.length) {
    const skip = skipSpecial(text, i);
    if (skip) {
      current += skip.keep;
      i = skip.end;
      unterminated ||= skip.unterminated === true;
    } else if (text[i] === ";") {
      statements.push(current);
      current = "";
      i++;
    } else {
      current += text[i++];
    }
  }
  statements.push(current);
  return { statements, unterminated };
}

function normTable(raw: string): string {
  return raw
    .replace(/\x22/g, "")
    .trim()
    .toLowerCase()
    .replace(/^public\./, "");
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|like|exclude)\b/i;

/** The identifier a column definition starts with, with an optional double quote in front, or "". */
function leadingIdentifier(part: string): string {
  const start = part[0] === DQ ? 1 : 0;
  let end = start;
  while (isTagChar(part[end], end === start)) end++;
  return part.slice(start, end);
}

function columnsOf(body: string): string[] {
  const names: string[] = [];
  for (const item of splitTopLevel(body)) {
    const part = item.trim();
    if (!part || CONSTRAINT_START.test(part)) continue;
    const name = leadingIdentifier(part);
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

function isOpenExpression(expr: string): boolean {
  const flat = expr.replace(/[\s()]/g, "").toLowerCase();
  return flat === "true" || flat === "1=1";
}

/** The first word of a role entry: WITH GRANT OPTION and CASCADE follow the role name after one space. */
function firstWord(entry: string): string {
  const space = entry.indexOf(" ");
  return space === -1 ? entry : entry.slice(0, space);
}

function rolesOf(clause: string | undefined): string[] {
  if (!clause) return ["public"];
  return clause
    .split(",")
    .map((r) => firstWord(r.replace(/\x22/g, "").trim().toLowerCase()))
    .filter(Boolean);
}

interface State {
  tables: Map<string, Set<string>>;
  rls: Set<string>;
  policies: Map<string, { table: string; open: boolean }>;
  grants: Map<string, true>;
  /** Tables where REVOKE SELECT left anon only the columns granted afterwards. */
  columnLimit: Map<string, Set<string>>;
  wildcard: boolean;
}

function addColumns(state: State, table: string, cols: string[]): void {
  const set = state.tables.get(table) ?? new Set<string>();
  for (const c of cols) set.add(c);
  state.tables.set(table, set);
}

const POLICY_HEAD_RE = /^create\s+policy\s+(\x22[^\x22]+\x22|\S+)\s+on\s+(\S+)([\s\S]*)$/i;
const POLICY_CMD_RE = /\bfor\s+(all|select|insert|update|delete)\b/i;
const POLICY_TO_RE = /\bto\s+([\w\x22,\s]+?)(?=\s+(using|with\s+check)\b|$)/i;
const POLICY_USING_RE = /\busing\s*\(/i;

/** The text inside the parentheses after USING, found by counting depth, or undefined. */
function usingExpression(rest: string): string | undefined {
  const m = POLICY_USING_RE.exec(rest);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < rest.length; i++) {
    if (rest[i] === "(") depth++;
    if (rest[i] === ")" && --depth === 0) return rest.slice(start, i);
  }
  return undefined;
}

/** True when the clauses after ON <table> let anon or public select every row. */
function opensRowsToAnon(rest: string): boolean {
  if (/\bas\s+restrictive\b/i.test(rest)) return false;
  const cmd = (rest.match(POLICY_CMD_RE)?.[1] ?? "all").toLowerCase();
  if (cmd !== "all" && cmd !== "select") return false;
  if (!rolesOf(rest.match(POLICY_TO_RE)?.[1]).some((r) => ANON_ROLES.has(r))) return false;
  const using = usingExpression(rest);
  return using !== undefined && isOpenExpression(using);
}

function applyPolicy(state: State, stmt: string): void {
  const head = stmt.match(POLICY_HEAD_RE);
  if (!head) return;
  const table = normTable(head[2]);
  state.policies.set(policyKey(table, head[1]), { table, open: opensRowsToAnon(head[3]) });
}

const GRANT_RE = /^grant\s+([\w\s,]+?)\s+on\s+(?:table\s+)?([\s\S]+?)\s+to\s+([\w\x22,\s]+)/i;
const REVOKE_RE =
  /^revoke\s+(?:grant\s+option\s+for\s+)?([\w\s,]+?)\s+on\s+(?:table\s+)?([\s\S]+?)\s+from\s+([\w\x22,\s]+)/i;

/** The object list of a grant or revoke that touches select for anon or public, else null. */
function anonGrantTargets(stmt: string, revoke: boolean): string | null {
  const m = stmt.match(revoke ? REVOKE_RE : GRANT_RE);
  if (!m || !/\b(select|all)\b/i.test(m[1])) return null;
  return rolesOf(m[3]).some((r) => ANON_ROLES.has(r)) ? m[2] : null;
}

const COLUMN_GRANT_RE =
  /^grant\s+select\s*\(([^)]*)\)\s+on\s+(?:table\s+)?(\S+)\s+to\s+([\w\x22,\s]+)/i;

/** GRANT SELECT (columns) ON t TO anon: adds columns to a table that REVOKE already limited. */
function applyColumnGrant(state: State, stmt: string): boolean {
  const m = stmt.match(COLUMN_GRANT_RE);
  if (!m) return false;
  if (!rolesOf(m[3]).some((r) => ANON_ROLES.has(r))) return true;
  const limit = state.columnLimit.get(normTable(m[2]));
  if (limit) for (const c of columnsOf(m[1])) limit.add(c);
  return true;
}

function applyGrant(state: State, stmt: string, revoke: boolean): void {
  const targets = anonGrantTargets(stmt, revoke);
  if (targets === null) return;
  if (/^all\s+tables\s+in\s+schema\s+public$/i.test(targets.trim())) {
    state.wildcard = !revoke;
    if (revoke) state.grants.clear();
    return;
  }
  for (const t of targets.split(",")) {
    const table = normTable(t);
    if (revoke) {
      state.grants.delete(table);
      state.columnLimit.set(table, new Set());
    } else {
      state.grants.set(table, true);
      state.columnLimit.delete(table);
    }
  }
}

const CREATE_TABLE_RE =
  /^create\s+table\s+(?:if\s+not\s+exists\s+)?(\S+?)\s*\(([\s\S]*)\)\s*[\w\s=(),\x27\x22]*$/i;
const ALTER_TABLE_RE = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(\S+)\s+([\s\S]*)$/i;
const DROP_POLICY_RE = /^drop\s+policy\s+(?:if\s+exists\s+)?(\x22[^\x22]+\x22|\S+)\s+on\s+(\S+)/i;

function policyKey(table: string, name: string): string {
  return `${table}\u0000${name.replace(/\x22/g, "")}`;
}

function applyAlter(state: State, table: string, action: string): void {
  if (/^enable\s+row\s+level\s+security\b/i.test(action)) state.rls.add(table);
  if (/^disable\s+row\s+level\s+security\b/i.test(action)) state.rls.delete(table);
  for (const add of action.matchAll(
    /add\s+column\s+(?:if\s+not\s+exists\s+)?\x22?([A-Za-z_]\w*)\x22?/gi,
  )) {
    addColumns(state, table, [add[1].toLowerCase()]);
  }
}

function applyStatement(state: State, raw: string): void {
  const stmt = raw.trim().replace(/\s+/g, " ");
  const create = stmt.match(CREATE_TABLE_RE);
  if (create) return addColumns(state, normTable(create[1]), columnsOf(create[2]));
  const alter = stmt.match(ALTER_TABLE_RE);
  if (alter) return applyAlter(state, normTable(alter[1]), alter[2]);
  const drop = stmt.match(DROP_POLICY_RE);
  if (drop) {
    state.policies.delete(policyKey(normTable(drop[2]), drop[1]));
    return;
  }
  if (/^create\s+policy\b/i.test(stmt)) return applyPolicy(state, stmt);
  if (/^grant\b/i.test(stmt) && applyColumnGrant(state, stmt)) return;
  if (/^grant\b/i.test(stmt)) return applyGrant(state, stmt, false);
  if (/^revoke\b/i.test(stmt)) applyGrant(state, stmt, true);
}

function personalOf(state: State, table: string): string[] {
  const limit = state.columnLimit.get(table);
  return [...(state.tables.get(table) ?? [])]
    .filter((c) => (limit === undefined || limit.has(c)) && PERSONAL_COLUMN.test(c))
    .sort();
}

function summarise(state: State): Omit<AnonAnalysis, "incomplete"> {
  const via = new Map<string, string[]>();
  const note = (table: string, how: string) => via.set(table, [...(via.get(table) ?? []), how]);
  for (const [key, p] of state.policies) {
    if (p.open) note(p.table, `policy "${key.split("\u0000")[1]}" (USING true)`);
  }
  const grantedTables = state.wildcard ? [...state.tables.keys()] : [];
  for (const t of [...state.grants.keys(), ...grantedTables]) {
    if (!state.rls.has(t)) note(t, "GRANT SELECT to anon without row level security");
  }
  const readable = [...via.entries()]
    .map(([table, how]) => ({
      table,
      personalColumns: personalOf(state, table),
      via: [...new Set(how)],
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
  return { readable };
}

/** Pure: apply the sources in the order given and list the tables anonymous readers can select from. */
export function analyzeAnonAccess(sources: SqlSource[]): AnonAnalysis {
  const state: State = {
    tables: new Map(),
    rls: new Set(),
    policies: new Map(),
    grants: new Map(),
    columnLimit: new Map(),
    wildcard: false,
  };
  const incomplete: string[] = [];
  for (const source of sources) {
    const { statements, unterminated } = splitStatements(source.text);
    if (unterminated) incomplete.push(source.file);
    for (const stmt of statements) applyStatement(state, stmt);
  }
  return { ...summarise(state), incomplete };
}

interface Collected {
  sources: SqlSource[];
  oversize: string[];
  truncated: boolean;
}

async function collectSql(root: string): Promise<Collected> {
  const found: string[] = [];
  const oversize: string[] = [];
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".sql")) {
        if (found.length >= MAX_SQL_FILES) truncated = true;
        else found.push(full);
      }
    }
  }
  await walk(root);
  const sources: SqlSource[] = [];
  for (const full of found.sort()) {
    const rel = relative(root, full);
    const info = await lstat(full);
    if (info.size > MAX_SQL_BYTES) {
      oversize.push(rel);
      continue;
    }
    sources.push({ file: rel, text: await readFile(full, "utf8") });
  }
  return { sources, oversize, truncated };
}

function describe(t: ReadableTable): string {
  const cols = t.personalColumns.length
    ? ` (personal columns: ${t.personalColumns.join(", ")})`
    : "";
  return `${t.table}${cols}`;
}

export async function checkAnonAccess(root: string): Promise<SecurityCheckResult> {
  const base = { category: "exposure", name: ANON_ACCESS_CHECK } as const;
  const { sources, oversize, truncated } = await collectSql(root);
  if (oversize.length > 0 || truncated) {
    const why = oversize.length
      ? `${oversize.join(", ")} is larger than ${MAX_SQL_BYTES} bytes and was not read`
      : `more than ${MAX_SQL_FILES} SQL files, the rest were not read`;
    return {
      ...base,
      status: "warn",
      didNotRun: true,
      scanIncomplete: true,
      detail: `scan incomplete: ${why}`,
    };
  }
  if (sources.length === 0) {
    return {
      ...base,
      status: "skip",
      detail: "no SQL files in the project, nothing to read policies from",
    };
  }
  const analysis = analyzeAnonAccess(sources);
  const count = `${sources.length} SQL file${sources.length === 1 ? "" : "s"}`;
  return withIncompleteNote(resultFor(analysis.readable, count), analysis.incomplete);
}

const BASE = { category: "exposure", name: ANON_ACCESS_CHECK } as const;
const SUGGESTION =
  "Replace USING (true) with a row-scoped condition, or move personal columns to a table anon cannot read. Run `kit check --category security` again after the migration.";

function resultFor(readable: ReadableTable[], count: string): SecurityCheckResult {
  if (readable.length === 0) {
    return { ...BASE, status: "pass", detail: `no table is readable by anon in ${count}` };
  }
  const list = readable.map(describe).join("; ");
  if (readable.some((t) => t.personalColumns.length > 0)) {
    return {
      ...BASE,
      status: "fail",
      severity: "high",
      hasFindings: true,
      detail: `anon can read ${readable.length} table(s) in ${count}: ${list}`,
      suggestion: SUGGESTION,
    };
  }
  return {
    ...BASE,
    status: "warn",
    severity: "medium",
    hasFindings: true,
    detail: `anon can read ${readable.length} table(s) in ${count}, none with a personal-looking column: ${list}`,
    suggestion: SUGGESTION,
  };
}

/** A file the lexer could not finish may hide statements: a pass becomes an incomplete scan, a finding keeps its status. */
function withIncompleteNote(
  result: SecurityCheckResult,
  incomplete: string[],
): SecurityCheckResult {
  if (incomplete.length === 0) return result;
  const note = `scan incomplete: unterminated quote, comment or dollar quote in ${incomplete.join(", ")}`;
  if (result.status !== "pass") return { ...result, detail: `${result.detail}; ${note}` };
  return { ...result, status: "warn", didNotRun: true, scanIncomplete: true, detail: note };
}
