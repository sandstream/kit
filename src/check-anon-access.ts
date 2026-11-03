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
}

const PERSONAL_COLUMN =
  /(^|_)(phone|mobile|telephone|tel|email|e_?mail|ssn|personnummer|national_?id|birth_?date|dob)(_|$)|(first|last|full|sur|customer|guest|contact|person)_?name$/;

const ANON_ROLES = new Set(["anon", "public"]);

const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);

function stripBlockComments(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf(BLOCK_OPEN, at);
    if (open === -1) return out + text.slice(at);
    out += text.slice(at, open) + " ";
    const close = text.indexOf(BLOCK_CLOSE, open + 2);
    if (close === -1) return out;
    at = close + 2;
  }
}

/** Remove dollar-quoted bodies and comments, so neither can pass for a statement. */
function stripSql(text: string): string {
  const withoutBodies = text.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ");
  return stripBlockComments(withoutBodies).replace(/--[^\n]*/g, " ");
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

function columnsOf(body: string): string[] {
  const names: string[] = [];
  for (const item of splitTopLevel(body)) {
    const part = item.trim();
    if (!part || CONSTRAINT_START.test(part)) continue;
    const name = part.match(/^\x22?([A-Za-z_]\w*)\x22?/);
    if (name) names.push(name[1].toLowerCase());
  }
  return names;
}

function isOpenExpression(expr: string): boolean {
  const flat = expr.replace(/[\s()]/g, "").toLowerCase();
  return flat === "true" || flat === "1=1";
}

function rolesOf(clause: string | undefined): string[] {
  if (!clause) return ["public"];
  return clause
    .split(",")
    .map((r) => r.replace(/\x22/g, "").trim().toLowerCase())
    .filter(Boolean);
}

interface State {
  tables: Map<string, Set<string>>;
  rls: Set<string>;
  policies: Map<string, { table: string; open: boolean }>;
  grants: Map<string, true>;
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
const POLICY_USING_RE = /\busing\s*(\([\s\S]*\))\s*(?:with\s+check|$)/i;

/** True when the clauses after ON <table> let anon or public select every row. */
function opensRowsToAnon(rest: string): boolean {
  if (/\bas\s+restrictive\b/i.test(rest)) return false;
  const cmd = (rest.match(POLICY_CMD_RE)?.[1] ?? "all").toLowerCase();
  if (cmd !== "all" && cmd !== "select") return false;
  if (!rolesOf(rest.match(POLICY_TO_RE)?.[1]).some((r) => ANON_ROLES.has(r))) return false;
  const using = rest.match(POLICY_USING_RE)?.[1];
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
    if (revoke) state.grants.delete(table);
    else state.grants.set(table, true);
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
  if (/^grant\b/i.test(stmt)) return applyGrant(state, stmt, false);
  if (/^revoke\b/i.test(stmt)) applyGrant(state, stmt, true);
}

function personalOf(state: State, table: string): string[] {
  return [...(state.tables.get(table) ?? [])].filter((c) => PERSONAL_COLUMN.test(c)).sort();
}

function summarise(state: State): AnonAnalysis {
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
    wildcard: false,
  };
  for (const source of sources) {
    for (const stmt of stripSql(source.text).split(";")) applyStatement(state, stmt);
  }
  return summarise(state);
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
  const { readable } = analyzeAnonAccess(sources);
  const count = `${sources.length} SQL file${sources.length === 1 ? "" : "s"}`;
  if (readable.length === 0) {
    return { ...base, status: "pass", detail: `no table is readable by anon in ${count}` };
  }
  const personal = readable.filter((t) => t.personalColumns.length > 0);
  const list = readable.map(describe).join("; ");
  const suggestion =
    "Replace USING (true) with a row-scoped condition, or move personal columns to a table anon cannot read. Run `kit check --category security` again after the migration.";
  if (personal.length > 0) {
    return {
      ...base,
      status: "fail",
      severity: "high",
      hasFindings: true,
      detail: `anon can read ${readable.length} table(s) in ${count}: ${list}`,
      suggestion,
    };
  }
  return {
    ...base,
    status: "warn",
    severity: "medium",
    hasFindings: true,
    detail: `anon can read ${readable.length} table(s) in ${count}, none with a personal-looking column: ${list}`,
    suggestion,
  };
}
