/**
 * `kit security routes`: an inventory of the routes a reviewer should look at for IDOR, hidden
 * admin pages and missing rate limits, the holes that cannot be decided statically.
 *
 * Lists each route whose path has an id parameter, names admin or an auth flow (login, signin,
 * signup, register, reset, password), or whose handler file imports an AI SDK. Two columns say
 * what was seen: an auth guard name or session call, and a rate limiter. Nothing here decides
 * that a route is safe or unsafe; an empty column means "no known name seen", not "unguarded".
 *
 * Read: source files from kit's walker (`walkSourceFiles`), text and regular expressions only.
 * Frameworks: Express, Fastify and Hono by call (route-inventory-calls.ts); Next.js app and pages
 * routers and SvelteKit by file place (route-inventory-files.ts). The limits of each are in those
 * files and in docs/FEATURES.md.
 */

import { dirname, join, relative, sep } from "node:path";

import { walkSourceFiles } from "./source-walk.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import { callRoutes, type RawRoute } from "./route-inventory-calls.js";
import { fileRoute, guardFileCandidates, type FileRoute } from "./route-inventory-files.js";
import {
  aiSdkImports,
  guardsIn,
  limitersIn,
  pathClasses,
  type RouteClass,
} from "./route-inventory-signals.js";

export interface RouteEntry {
  framework: string;
  method: string;
  path: string;
  file: string;
  line: number;
  classes: RouteClass[];
  aiSdks: string[];
  authGuardSeen: string[];
  rateLimiterSeen: string[];
}

export interface RouteInventory {
  routes: RouteEntry[];
  /** Every route found, listed or not. */
  totalRoutes: number;
  filesRead: number;
  /** Files over the size cap or unreadable, project-relative. */
  notRead: string[];
  note: string;
  notCovered: string[];
}

const INVENTORY_NOTE =
  "An inventory, not a verdict: IDOR (one user reading another's record) and missing rate limits are not decided statically. Each row is listed for a person to review. An empty column means no known guard or limiter name was seen, not that the route is unguarded; a name seen does not prove it covers the route.";

const NOT_COVERED = [
  "router mount prefixes (app.use('/api', router)) and paths built at runtime",
  "handlers imported from another file (only the registering call or route file is read)",
  "which routes a use()/register() call, Next.js middleware matcher or SvelteKit hook covers",
  "Next.js server actions, rewrites and intercepting routes",
  "Koa, NestJS decorators, tRPC procedures, Remix/React Router, Nuxt, Astro and non-JS servers",
];

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".svelte"];
const SKIP_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".git",
  "coverage",
  "vendor",
  "__tests__",
  "__mocks__",
];
const MAX_BYTES = 1024 * 1024;

type Reader = (rel: string) => string | null;

/** A cached reader of project-relative files; null when missing, oversize or unreadable. */
function makeReader(root: string, notRead: string[]): Reader {
  const cache = new Map<string, string | null>();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel) ?? null;
    let text: string | null = null;
    try {
      const full = join(root, ...rel.split("/"));
      const bytes = readRegularFileBytesIfPresent(full, MAX_BYTES);
      text = bytes?.toString("utf8") ?? null;
    } catch {
      notRead.push(rel);
    }
    cache.set(rel, text);
    return text;
  };
}

interface Frameworks {
  next: boolean;
  sveltekit: boolean;
}

/** Whether a package.json from the file's directory up to the root declares Next.js or SvelteKit. */
function makeFrameworkLookup(read: Reader): (rel: string) => Frameworks {
  const byDir = new Map<string, Frameworks>();
  const lookup = (dir: string): Frameworks => {
    const hit = byDir.get(dir);
    if (hit) return hit;
    const parent = dir === "." ? null : lookup(dirname(dir));
    const own = declared(read(dir === "." ? "package.json" : `${dir}/package.json`));
    const result = {
      next: own.next || !!parent?.next,
      sveltekit: own.sveltekit || !!parent?.sveltekit,
    };
    byDir.set(dir, result);
    return result;
  };
  return (rel) => lookup(dirname(rel));
}

function declared(pkgText: string | null): Frameworks {
  if (!pkgText) return { next: false, sveltekit: false };
  try {
    const pkg = JSON.parse(pkgText) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return { next: "next" in deps, sveltekit: "@sveltejs/kit" in deps };
  } catch {
    return { next: false, sveltekit: false };
  }
}

function labelled(label: string, names: string[]): string[] {
  const suffix =
    label === "middleware" || label === "proxy" || label === "hooks.server"
      ? " (coverage not read)"
      : "";
  return names.map((n) => `${label}: ${n}${suffix}`);
}

/** A file route as raw routes, one per method, with guards from the files around it. */
function fromFileRoute(rel: string, text: string, r: FileRoute, read: Reader): RawRoute[] {
  const contextGuards: string[] = [];
  const contextLimiters: string[] = [];
  let handlerText = text;
  let methods = r.methods;
  for (const c of guardFileCandidates(r)) {
    const t = read(c.file);
    if (t === null) continue;
    if (c.label === "+page.server") {
      handlerText += `\n${t}`;
      if (/export\s+const\s+actions\b/.test(t)) methods = [...methods, "ACTIONS"];
      continue;
    }
    contextGuards.push(...labelled(c.label, guardsIn(t)));
    contextLimiters.push(...labelled(c.label, limitersIn(t)));
  }
  return methods.map((method) => ({
    framework: r.framework,
    method,
    path: r.path,
    file: rel,
    line: r.line,
    handlerText,
    contextGuards: [...new Set(contextGuards)],
    contextLimiters: [...new Set(contextLimiters)],
  }));
}

/** AI SDKs come from the file's imports (and, for a SvelteKit page, its `+page.server`). */
function toEntry(raw: RawRoute, fileText: string): RouteEntry {
  const aiSdks = aiSdkImports(`${fileText}\n${raw.handlerText}`);
  const classes = pathClasses(raw.path);
  if (aiSdks.length) classes.push("ai");
  return {
    framework: raw.framework,
    method: raw.method,
    path: raw.path,
    file: raw.file,
    line: raw.line,
    classes,
    aiSdks,
    authGuardSeen: [...new Set([...guardsIn(raw.handlerText), ...raw.contextGuards])],
    rateLimiterSeen: [...new Set([...limitersIn(raw.handlerText), ...raw.contextLimiters])],
  };
}

/** Raw routes from one file: by call for server frameworks, by place for file routers. */
function routesOf(rel: string, text: string, read: Reader, fw: Frameworks): RawRoute[] {
  const byCall = callRoutes(rel, text);
  if (byCall.length) return byCall;
  const r = fileRoute(rel, text, fw);
  return r ? fromFileRoute(rel, text, r, read) : [];
}

export function buildRouteInventory(root: string): RouteInventory {
  const notRead: string[] = [];
  const read = makeReader(root, notRead);
  const frameworksOf = makeFrameworkLookup(read);
  const files = walkSourceFiles(root, { exts: EXTS, skipDirs: SKIP_DIRS });
  const all: RouteEntry[] = [];
  let filesRead = 0;
  for (const full of files) {
    const rel = relative(root, full).split(sep).join("/");
    const text = read(rel);
    if (text === null) continue;
    filesRead++;
    for (const raw of routesOf(rel, text, read, frameworksOf(rel))) all.push(toEntry(raw, text));
  }
  const routes = all
    .filter((r) => r.classes.length > 0)
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method),
    );
  return {
    routes,
    totalRoutes: all.length,
    filesRead,
    notRead: [...new Set(notRead)],
    note: INVENTORY_NOTE,
    notCovered: NOT_COVERED,
  };
}
