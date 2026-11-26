/**
 * Routes registered by a call, the Express / Fastify / Hono style:
 * `app.get("/invoice/:id", requireAuth, handler)`, `router.route("/x").get(…).post(…)`,
 * `fastify.route({ method: "GET", url: "/x", preHandler: … })`.
 *
 * A file is read only when it imports `express`, `fastify` or `hono`. The path is the string
 * literal as written: a router's mount prefix (`app.use("/api", router)` in another file) is not
 * resolved, and a path built at runtime is not seen. The handler text is the call's argument
 * list, so a guard passed by name or called inline is seen; a handler imported from another file
 * is not followed. `use()`, `register()` and `addHook()` calls earlier in the same file are
 * reported as context, without deciding which routes they cover.
 */

import { guardsIn, importedSpecifiers, limitersIn } from "./route-inventory-signals.js";

export interface RawRoute {
  framework: string;
  method: string;
  path: string;
  /** Project-relative, `/`-separated. */
  file: string;
  line: number;
  /** The text the route's own guards and limiters are read from. */
  handlerText: string;
  /** Guards seen around the route, each labelled with where (`use()`, `middleware.ts`, `layout`). */
  contextGuards: string[];
  contextLimiters: string[];
}

const QUOTES = new Set(["'", '"', "`"]);

/** End offset (exclusive) of the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else if (text[i] === "\n" && quote !== "`") return i;
    else i++;
  }
  return text.length;
}

/** Replace JS comments with spaces (newlines kept), leaving strings intact. */
export function blankJsComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    let end = i + 1;
    if (QUOTES.has(text[i])) end = stringEnd(text, i);
    else if (two === "//") end = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    else if (two === "/*")
      end = text.indexOf("*/", i + 2) === -1 ? text.length : text.indexOf("*/", i + 2) + 2;
    const piece = text.slice(i, end);
    out += two === "//" || two === "/*" ? piece.replace(/[^\n]/g, " ") : piece;
    i = end;
  }
  return out;
}

/** Offset just after the bracket that closes the one at `open`, strings skipped. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (QUOTES.has(ch)) {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    i++;
    if (depth === 0) return i;
  }
  return text.length;
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

const FRAMEWORKS: [string, (s: string) => boolean][] = [
  ["express", (s) => s === "express"],
  ["fastify", (s) => s === "fastify"],
  ["hono", (s) => s === "hono" || s.startsWith("hono/")],
];

/** The server framework a file imports, or null. */
function callFramework(text: string): string | null {
  const specs = importedSpecifiers(text);
  for (const [name, test] of FRAMEWORKS) if (specs.some(test)) return name;
  return null;
}

/** Receivers that are HTTP clients or maps, not routers. */
const NOT_ROUTERS = new Set([
  "axios",
  "http",
  "https",
  "client",
  "request",
  "req",
  "res",
  "ky",
  "got",
  "superagent",
  "supertest",
  "agent",
  "fetcher",
  "params",
  "searchParams",
  "headers",
  "map",
  "cache",
]);

const VERB_CALL =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|del|all|options|head)\s*\(\s*(['"`])(\/[^'"`\n]*)\3/g;
const ROUTE_CHAIN = /\.route\s*\(\s*(['"`])(\/[^'"`\n]*)\1\s*\)/g;
const CHAINED_VERB = /^\s*\.(get|post|put|patch|delete|all|options|head)\s*\(/;
const ROUTE_OBJECT = /\.route\s*\(\s*\{/g;
const CONTEXT_CALL = /\b[A-Za-z_$][\w$]*\.(use|register|addHook)\s*\(/g;

interface Ctx {
  file: string;
  framework: string;
  text: string;
  /** Offsets and texts of use()/register()/addHook() calls, in order. */
  context: { at: number; text: string }[];
}

function route(ctx: Ctx, method: string, path: string, at: number, handlerText: string): RawRoute {
  const before = ctx.context.filter((u) => u.at < at).map((u) => u.text);
  const label = (names: string[]): string[] => names.map((n) => `use(): ${n}`);
  return {
    framework: ctx.framework,
    method,
    path,
    file: ctx.file,
    line: lineOf(ctx.text, at),
    handlerText,
    contextGuards: label([...new Set(before.flatMap(guardsIn))]),
    contextLimiters: label([...new Set(before.flatMap(limitersIn))]),
  };
}

function verbRoutes(ctx: Ctx): RawRoute[] {
  const out: RawRoute[] = [];
  for (const m of ctx.text.matchAll(VERB_CALL)) {
    if (NOT_ROUTERS.has(m[1])) continue;
    const open = ctx.text.indexOf("(", m.index + m[1].length);
    const args = ctx.text.slice(open, closeOf(ctx.text, open));
    const method = m[2] === "del" ? "DELETE" : m[2].toUpperCase();
    out.push(route(ctx, method, m[4], m.index, args));
  }
  return out;
}

function chainRoutes(ctx: Ctx): RawRoute[] {
  const out: RawRoute[] = [];
  for (const m of ctx.text.matchAll(ROUTE_CHAIN)) {
    let i = m.index + m[0].length;
    let verb: RegExpExecArray | null;
    while ((verb = CHAINED_VERB.exec(ctx.text.slice(i))) !== null) {
      const open = i + verb[0].length - 1;
      const end = closeOf(ctx.text, open);
      out.push(route(ctx, verb[1].toUpperCase(), m[2], m.index, ctx.text.slice(open, end)));
      i = end;
    }
  }
  return out;
}

function objectRoutes(ctx: Ctx): RawRoute[] {
  const out: RawRoute[] = [];
  for (const m of ctx.text.matchAll(ROUTE_OBJECT)) {
    const open = m.index + m[0].length - 1;
    const body = ctx.text.slice(open, closeOf(ctx.text, open));
    const url = /\burl\s*:\s*(['"`])(\/[^'"`\n]*)\1/.exec(body);
    if (!url) continue;
    const methodField = /\bmethod\s*:\s*(\[[^\]]*\]|(['"`])\w+\2)/.exec(body);
    const methods = methodField ? (methodField[1].match(/\w+/g) ?? []) : ["?"];
    for (const method of methods) out.push(route(ctx, method.toUpperCase(), url[2], m.index, body));
  }
  return out;
}

/** Routes a framework file registers by call. */
export function callRoutes(file: string, source: string): RawRoute[] {
  const framework = callFramework(source);
  if (!framework) return [];
  const text = blankJsComments(source);
  const context = [...text.matchAll(CONTEXT_CALL)].map((m) => {
    const open = m.index + m[0].length - 1;
    return { at: m.index, text: text.slice(open, closeOf(text, open)) };
  });
  const ctx: Ctx = { file, framework, text, context };
  return [...verbRoutes(ctx), ...chainRoutes(ctx), ...objectRoutes(ctx)];
}
