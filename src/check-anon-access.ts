/**
 * Anonymous database access, read statically from SQL migrations.
 *
 * A policy such as `FOR SELECT USING (true)` lets anyone with the public anon key read every row
 * of a table. The migration reads like ordinary public-content setup, so the exposure is easy to
 * miss, above all when the table also holds a phone number or an email address.
 *
 * Static first: this reads `CREATE POLICY`, `GRANT` and `REVOKE` statements in file name order and
 * lists each table that anonymous readers can select from. A live check against a database needs a
 * read-only role and is deferred. Out of scope here: roles other than anon and public, and policies
 * created outside the SQL files in the repository.
 *
 * On a Supabase project, a new table in `public` starts with every privilege granted to `anon` and
 * `authenticated` through default privileges, so a `public` table without row level security is
 * readable with the publishable key ("A table in an exposed schema without RLS is readable and
 * writable by any role with a grant on it",
 * https://supabase.com/docs/guides/database/postgres/row-level-security). There, a table created in
 * `public` counts as granted to anon unless a `REVOKE … FROM anon` on it, on all tables in `public`,
 * or an `ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon` before it takes the grant away. Other
 * schemas are not exposed by default and are skipped. `FORCE ROW LEVEL SECURITY` alone does not
 * enable it.
 *
 * A second row, `signed-in database access`, lists each table where a permissive policy
 * `TO authenticated USING (true)` for select or all lets every signed-in user read every row. On
 * Supabase anyone can sign up, so on most apps that is close to public. It warns, and fails only
 * when the table has a personal-looking column, by the same column rule as the anon row. A table
 * anon can already read is left to the anon row.
 */

import { constants } from "node:fs";
import { access, open, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { columnsOf, normTable, splitStatements } from "./anon-sql-statements.js";
import { loadPublicTables, type PublicTables } from "./anon-public-tables.js";
import type { SecurityCheckResult } from "./check-security.js";

const ANON_ACCESS_CHECK = "anonymous database access";
const SIGNED_IN_ACCESS_CHECK = "signed-in database access";

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
  /** Tables anon cannot read that every signed-in user can, through `TO authenticated USING (true)`. */
  signedIn: ReadableTable[];
  /** Files with an unterminated quote, comment or dollar quote, which may hide statements. */
  incomplete: string[];
}

const PERSONAL_COLUMN =
  /(^|_)(phone|mobile|telephone|tel|email|e_?mail|ssn|personnummer|national_?id|birth_?date|dob)(_|$)|(first|last|full|sur|customer|guest|contact|person)_?name$/;

const ANON_ROLES = new Set(["anon", "public"]);

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
  policies: Map<string, { table: string; open: boolean; signedIn: boolean }>;
  grants: Map<string, true>;
  /** Tables where REVOKE SELECT left anon only the columns granted afterwards. */
  columnLimit: Map<string, Set<string>>;
  wildcard: boolean;
  /** Supabase only: public tables that still hold the default grant to anon. */
  defaultGranted: Set<string>;
  /** Supabase only: ALTER DEFAULT PRIVILEGES took select on new public tables away from anon. */
  defaultsRevoked: boolean;
  supabase: boolean;
}

export interface AnonAccessOptions {
  /** Model Supabase's default grants: a public table without row level security is readable by anon. */
  supabase?: boolean;
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

/** The roles a permissive select-or-all policy with USING (true) opens every row to, else none. */
function rolesOpenedToAllRows(rest: string): string[] {
  if (/\bas\s+restrictive\b/i.test(rest)) return [];
  const cmd = (rest.match(POLICY_CMD_RE)?.[1] ?? "all").toLowerCase();
  if (cmd !== "all" && cmd !== "select") return [];
  // Not named `using`: a contextual keyword that some parsers read as a declaration.
  const condition = usingExpression(rest);
  if (condition === undefined || !isOpenExpression(condition)) return [];
  return rolesOf(rest.match(POLICY_TO_RE)?.[1]);
}

function applyPolicy(state: State, stmt: string): void {
  const head = stmt.match(POLICY_HEAD_RE);
  if (!head) return;
  const table = normTable(head[2]);
  const roles = rolesOpenedToAllRows(head[3]);
  state.policies.set(policyKey(table, head[1]), {
    table,
    open: roles.some((r) => ANON_ROLES.has(r)),
    signedIn: roles.includes("authenticated"),
  });
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

/** A table name normTable left without a schema is in `public`, the only schema Supabase exposes by default. */
function isPublicTable(table: string): boolean {
  return !table.includes(".");
}

function createTable(state: State, table: string, cols: string[]): void {
  addColumns(state, table, cols);
  if (isPublicTable(table) && !state.defaultsRevoked) state.defaultGranted.add(table);
}

function namesAnon(roles: string): boolean {
  return rolesOf(roles).includes("anon");
}

/** REVOKE SELECT or ALL … FROM anon removes the Supabase default grant; FROM public does not, anon holds its own. */
function applyRevoke(state: State, stmt: string): void {
  applyGrant(state, stmt, true);
  const m = stmt.match(REVOKE_RE);
  if (!m || !/\b(select|all)\b/i.test(m[1]) || !namesAnon(m[3])) return;
  if (/^all\s+tables\s+in\s+schema\s+public$/i.test(m[2].trim())) {
    state.defaultGranted.clear();
    return;
  }
  for (const t of m[2].split(",")) state.defaultGranted.delete(normTable(t));
}

const DROP_TABLE_RE = /^drop\s+table\s+(?:if\s+exists\s+)?([^;]+?)(?:\s+(?:cascade|restrict))?$/i;

function dropTables(state: State, stmt: string): void {
  const m = stmt.match(DROP_TABLE_RE);
  if (!m) return;
  for (const t of m[1].split(",")) state.defaultGranted.delete(normTable(t));
}

const DEFAULT_PRIVILEGES_RE =
  /^alter\s+default\s+privileges\s+(?:for\s+(?:role|user)\s+[\w\x22,\s]+?\s+)?(?:in\s+schema\s+([\w\x22,\s]+?)\s+)?(grant|revoke)\s+(?:grant\s+option\s+for\s+)?([\w\s,]+?)\s+on\s+tables\s+(?:to|from)\s+([\w\x22,\s]+)/i;

/** ALTER DEFAULT PRIVILEGES [IN SCHEMA public] REVOKE SELECT|ALL ON TABLES FROM anon: later tables get no grant. */
function applyDefaultPrivileges(state: State, stmt: string): void {
  const m = stmt.match(DEFAULT_PRIVILEGES_RE);
  if (!m || !/\b(select|all)\b/i.test(m[3]) || !namesAnon(m[4])) return;
  if (m[1] !== undefined && !rolesOf(m[1]).includes("public")) return;
  state.defaultsRevoked = m[2].toLowerCase() === "revoke";
}

function applyStatement(state: State, raw: string): void {
  const stmt = raw.trim().replace(/\s+/g, " ");
  const create = stmt.match(CREATE_TABLE_RE);
  if (create) return createTable(state, normTable(create[1]), columnsOf(create[2]));
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
  if (/^revoke\b/i.test(stmt)) return applyRevoke(state, stmt);
  if (/^drop\s+table\b/i.test(stmt)) return dropTables(state, stmt);
  if (/^alter\s+default\s+privileges\b/i.test(stmt)) applyDefaultPrivileges(state, stmt);
}

function personalOf(state: State, table: string): string[] {
  const limit = state.columnLimit.get(table);
  return [...(state.tables.get(table) ?? [])]
    .filter((c) => (limit === undefined || limit.has(c)) && PERSONAL_COLUMN.test(c))
    .sort();
}

/** Tables a `TO authenticated USING (true)` policy opens, less those anon can already read. */
function signedInTables(state: State, anonReadable: Set<string>): ReadableTable[] {
  const via = new Map<string, string[]>();
  for (const [key, p] of state.policies) {
    if (!p.signedIn || anonReadable.has(p.table)) continue;
    const how = `policy "${key.split("\u0000")[1]}" (TO authenticated USING true)`;
    via.set(p.table, [...(via.get(p.table) ?? []), how]);
  }
  return [...via.entries()]
    .map(([table, how]) => ({
      table,
      personalColumns: [...(state.tables.get(table) ?? [])]
        .filter((c) => PERSONAL_COLUMN.test(c))
        .sort(),
      via: how,
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
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
  for (const t of state.supabase ? state.defaultGranted : []) {
    if (!state.rls.has(t))
      note(t, "Supabase default grant to anon, row level security not enabled");
  }
  const readable = [...via.entries()]
    .map(([table, how]) => ({
      table,
      personalColumns: personalOf(state, table),
      via: [...new Set(how)],
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
  return { readable, signedIn: signedInTables(state, new Set(via.keys())) };
}

/** Pure: apply the sources in the order given and list the tables anonymous readers can select from. */
export function analyzeAnonAccess(
  sources: SqlSource[],
  options: AnonAccessOptions = {},
): AnonAnalysis {
  const state: State = {
    tables: new Map(),
    rls: new Set(),
    policies: new Map(),
    grants: new Map(),
    columnLimit: new Map(),
    wildcard: false,
    defaultGranted: new Set(),
    defaultsRevoked: false,
    supabase: options.supabase === true,
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
  /** Files that could not be opened or read, for example one replaced by a symlink after it was listed. */
  unreadable: string[];
  truncated: boolean;
}

/**
 * Open once and check the size and read through the same handle, so the file cannot change between
 * the check and the read. A link is refused where the platform supports it.
 */
async function readSqlFile(full: string): Promise<string | "oversize" | "unreadable"> {
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return "unreadable";
    if (info.size > MAX_SQL_BYTES) return "oversize";
    return await handle.readFile("utf8");
  } catch {
    return "unreadable";
  } finally {
    await handle?.close();
  }
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
  const unreadable: string[] = [];
  for (const full of found.sort()) {
    const rel = relative(root, full);
    const read = await readSqlFile(full);
    if (read === "oversize") oversize.push(rel);
    else if (read === "unreadable") unreadable.push(rel);
    else sources.push({ file: rel, text: read });
  }
  return { sources, oversize, unreadable, truncated };
}

const SUPABASE_PACKAGES = ["@supabase/supabase-js", "supabase"];

/**
 * The signals `kit monkey-test` uses for Supabase, without its free-text match: a Supabase CLI
 * project (`supabase/config.toml`) or a Supabase package in package.json.
 */
async function isSupabaseProject(root: string): Promise<boolean> {
  try {
    await access(join(root, "supabase", "config.toml"));
    return true;
  } catch {
    // not a Supabase CLI project; fall through to package.json
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return SUPABASE_PACKAGES.some((name) => name in deps);
  } catch {
    return false;
  }
}

function describe(t: ReadableTable): string {
  const cols = t.personalColumns.length
    ? ` (personal columns: ${t.personalColumns.join(", ")})`
    : "";
  return `${t.table}${cols}`;
}

function notReadReason(c: Pick<Collected, "oversize" | "unreadable" | "truncated">): string | null {
  const parts: string[] = [];
  if (c.oversize.length) {
    parts.push(`${c.oversize.join(", ")} is larger than ${MAX_SQL_BYTES} bytes and was not read`);
  }
  if (c.unreadable.length) parts.push(`${c.unreadable.join(", ")} could not be read`);
  if (c.truncated) parts.push(`more than ${MAX_SQL_FILES} SQL files, the rest were not read`);
  return parts.length ? parts.join("; ") : null;
}

export async function checkAnonAccess(root: string): Promise<SecurityCheckResult> {
  return (await checkDatabaseAccess(root))[0];
}

/** Both rows from one read of the SQL files: `anonymous database access`, then `signed-in database access`. */
export async function checkDatabaseAccess(
  root: string,
): Promise<[SecurityCheckResult, SecurityCheckResult]> {
  const both = (r: Omit<SecurityCheckResult, "category" | "name">) =>
    [ANON_ACCESS_CHECK, SIGNED_IN_ACCESS_CHECK].map((name) => ({
      ...r,
      category: "exposure",
      name,
    })) as [SecurityCheckResult, SecurityCheckResult];
  const { sources, oversize, unreadable, truncated } = await collectSql(root);
  const why = notReadReason({ oversize, unreadable, truncated });
  if (why) {
    return both({
      status: "warn",
      didNotRun: true,
      scanIncomplete: true,
      detail: `scan incomplete: ${why}`,
    });
  }
  if (sources.length === 0) {
    return both({
      status: "skip",
      detail: "no SQL files in the project, nothing to read policies from",
    });
  }
  const analysis = analyzeAnonAccess(sources, { supabase: await isSupabaseProject(root) });
  const count = `${sources.length} SQL file${sources.length === 1 ? "" : "s"}`;
  const declared = await loadPublicTables(root, normTable);
  return [
    withIncompleteNote(resultFor(analysis.readable, count, declared), analysis.incomplete),
    withIncompleteNote(signedInResult(analysis.signedIn, count, declared), analysis.incomplete),
  ];
}

const SIGNED_IN_BASE = { category: "exposure", name: SIGNED_IN_ACCESS_CHECK } as const;
const SIGNED_IN_SUGGESTION =
  "Replace USING (true) on each listed table with a row-scoped condition such as USING (auth.uid() = user_id), or move personal columns to a table each user reads only their own rows of. A table every signed-in user may read on purpose, with no personal-looking column, can be declared under [anon_access.public] in .kit.toml with a reason.";

/** Warn for a table every signed-in user can read; fail high when it has a personal-looking column. */
function signedInResult(
  all: ReadableTable[],
  count: string,
  declared: PublicTables,
): SecurityCheckResult {
  const accepted = all.filter((t) => !t.personalColumns.length && declared.reasons.has(t.table));
  const open = all.filter((t) => !accepted.includes(t));
  const suffix = accepted.length
    ? ` (${accepted.length} declared public: ${accepted.map((t) => t.table).join(", ")})`
    : "";
  if (open.length === 0) {
    const what = accepted.length ? "no undeclared table" : "no table";
    return {
      ...SIGNED_IN_BASE,
      status: "pass",
      detail: `${what} is readable in full by every signed-in user in ${count}${suffix}`,
    };
  }
  const personal = open.some((t) => t.personalColumns.length > 0);
  return {
    ...SIGNED_IN_BASE,
    status: personal ? "fail" : "warn",
    severity: personal ? "high" : "medium",
    hasFindings: true,
    detail: `every signed-in user can read every row of ${open.length} table(s) in ${count}: ${open.map(describe).join("; ")}${suffix}`,
    suggestion: SIGNED_IN_SUGGESTION,
  };
}

const BASE = { category: "exposure", name: ANON_ACCESS_CHECK } as const;
const SUGGESTION =
  "Enable row level security on each listed table and replace USING (true) with a row-scoped condition, or move personal columns to a table anon cannot read. If a table without personal columns is public on purpose, declare it under [anon_access.public] in .kit.toml with a reason. Run `kit check --category security` again after the migration.";

function resultFor(
  all: ReadableTable[],
  count: string,
  declared: PublicTables,
): SecurityCheckResult {
  // A declaration never covers a table with a personal-looking column.
  const accepted = all.filter((t) => !t.personalColumns.length && declared.reasons.has(t.table));
  const readable = all.filter((t) => !accepted.includes(t));
  const notes: string[] = [];
  if (accepted.length) {
    notes.push(`${accepted.length} declared public: ${accepted.map((t) => t.table).join(", ")}`);
  }
  if (declared.noReason.length) {
    notes.push(
      `ignored [anon_access.public] entries with no reason: ${declared.noReason.join(", ")}`,
    );
  }
  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  if (readable.length === 0 && declared.noReason.length === 0) {
    const what = accepted.length ? "no undeclared table" : "no table";
    return { ...BASE, status: "pass", detail: `${what} is readable by anon in ${count}${suffix}` };
  }
  if (readable.length === 0) {
    return {
      ...BASE,
      status: "warn",
      severity: "low",
      detail: `no undeclared table is readable by anon in ${count}${suffix}`,
      suggestion: "Give each [anon_access.public] entry in .kit.toml a reason.",
    };
  }
  const list = readable.map(describe).join("; ");
  if (readable.some((t) => t.personalColumns.length > 0)) {
    return {
      ...BASE,
      status: "fail",
      severity: "high",
      hasFindings: true,
      detail: `anon can read ${readable.length} table(s) in ${count}: ${list}${suffix}`,
      suggestion: SUGGESTION,
    };
  }
  return {
    ...BASE,
    status: "warn",
    severity: "medium",
    hasFindings: true,
    detail: `anon can read ${readable.length} table(s) in ${count}, none with a personal-looking column: ${list}${suffix}`,
    suggestion: SUGGESTION,
  };
}

/**
 * A file the lexer could not finish may hide statements. A pass becomes an incomplete scan. A warning
 * becomes did-not-run, so the gate does not take it for a finding-level warning. A failure stays a
 * failure and is marked incomplete.
 */
function withIncompleteNote(
  result: SecurityCheckResult,
  incomplete: string[],
): SecurityCheckResult {
  if (incomplete.length === 0) return result;
  const note = `scan incomplete: unterminated quote, comment or dollar quote in ${incomplete.join(", ")}`;
  const detail = result.status === "pass" ? note : `${result.detail}; ${note}`;
  if (result.status === "fail") return { ...result, detail, scanIncomplete: true };
  return { ...result, status: "warn", didNotRun: true, scanIncomplete: true, detail };
}
