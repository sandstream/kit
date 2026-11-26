/**
 * Routes a file's place declares: Next.js (app router `route.*` and `page.*`, pages router
 * `pages/**`) and SvelteKit (`src/routes/**` `+server.*`, `+page.svelte`, `+page.server.*`).
 *
 * Paths are project-relative and `/`-separated. The routing root is the first `app`, `pages` or
 * `routes` directory in the path, so a route whose own path contains such a segment is read from
 * the first one. Route groups `(name)`, parallel slots `@name` and `_private` folders are handled
 * as the frameworks document them; intercepting routes and rewrites are not. Which framework a
 * file belongs to is decided by the nearest package.json that declares `next` or `@sveltejs/kit`.
 */

import { lineOf } from "./route-inventory-calls.js";

export type FileFramework = "next-app" | "next-pages" | "sveltekit";

export interface FileRoute {
  framework: FileFramework;
  methods: string[];
  path: string;
  /** The directory that holds the routing root (`app`, `pages`, `routes`), project-relative. */
  base: string;
  /** Directories from the routing root down to the route, for layout lookups. */
  dirs: string[];
  line: number;
}

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const EXPORTED_VERB =
  /export\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const RE_EXPORTED_VERB = /export\s*\{([^}]*)\}/g;

/** HTTP verbs a route module exports, by declaration or in an export list. */
export function exportedVerbs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EXPORTED_VERB)) out.add(m[1]);
  for (const m of text.matchAll(RE_EXPORTED_VERB)) {
    for (const part of m[1].split(",")) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? "";
      if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/** The line of the first exported verb, or 1. */
function firstVerbLine(text: string): number {
  EXPORTED_VERB.lastIndex = 0;
  const m = EXPORTED_VERB.exec(text);
  EXPORTED_VERB.lastIndex = 0;
  return m ? lineOf(text, m.index) : 1;
}

/** URL segments for directory names: groups and slots dropped. */
function urlSegments(dirs: string[]): string[] {
  return dirs.filter((d) => !(d.startsWith("(") && d.endsWith(")")) && !d.startsWith("@"));
}

function toPath(segments: string[]): string {
  return `/${segments.join("/")}`;
}

interface Split {
  base: string;
  dirs: string[];
  name: string;
}

/** Split `a/b/app/x/y/route.ts` at the first `root` segment. */
function splitAt(file: string, root: string): Split | null {
  const parts = file.split("/");
  const at = parts.indexOf(root);
  if (at === -1 || at === parts.length - 1) return null;
  return {
    base: parts.slice(0, at).join("/"),
    dirs: parts.slice(at + 1, -1),
    name: parts[parts.length - 1],
  };
}

function nextApp(file: string, text: string): FileRoute | null {
  const s = splitAt(file, "app");
  if (!s || s.dirs.some((d) => d.startsWith("_")) || !CODE.test(s.name)) return null;
  const stem = s.name.replace(CODE, "");
  const route = {
    framework: "next-app" as const,
    path: toPath(urlSegments(s.dirs)),
    base: s.base,
    dirs: s.dirs,
  };
  if (stem === "route") {
    const methods = exportedVerbs(text);
    return { ...route, methods: methods.length ? methods : ["?"], line: firstVerbLine(text) };
  }
  if (stem === "page") return { ...route, methods: ["PAGE"], line: 1 };
  return null;
}

const NEXT_SPECIAL_PAGES = new Set(["_app", "_document", "_error", "404", "500"]);

function nextPages(file: string): FileRoute | null {
  const s = splitAt(file, "pages");
  if (!s || !CODE.test(s.name)) return null;
  const stem = s.name.replace(CODE, "");
  if (NEXT_SPECIAL_PAGES.has(stem) || stem.startsWith("_")) return null;
  const segments = stem === "index" ? s.dirs : [...s.dirs, stem];
  const api = s.dirs[0] === "api";
  return {
    framework: "next-pages",
    methods: [api ? "ANY" : "PAGE"],
    path: toPath(segments),
    base: s.base,
    dirs: s.dirs,
    line: 1,
  };
}

function svelteKit(file: string, text: string): FileRoute | null {
  const s = splitAt(file, "routes");
  if (!s) return null;
  const route = {
    framework: "sveltekit" as const,
    path: toPath(urlSegments(s.dirs)),
    base: s.base,
    dirs: s.dirs,
  };
  if (/^\+server\.(?:ts|js)$/.test(s.name)) {
    const methods = exportedVerbs(text);
    return { ...route, methods: methods.length ? methods : ["?"], line: firstVerbLine(text) };
  }
  if (s.name === "+page.svelte") return { ...route, methods: ["PAGE"], line: 1 };
  return null;
}

/** The route a file declares by its place, for the framework its package declares. */
export function fileRoute(
  file: string,
  text: string,
  frameworks: { next: boolean; sveltekit: boolean },
): FileRoute | null {
  if (frameworks.sveltekit) {
    const r = svelteKit(file, text);
    if (r) return r;
  }
  if (!frameworks.next) return null;
  return nextApp(file, text) ?? (file.split("/").includes("pages") ? nextPages(file) : null);
}

/**
 * Files around a route that may guard it, project-relative: Next.js `middleware`/`proxy` beside
 * the routing root and `layout` files above the route; SvelteKit `hooks.server` beside the
 * routing root, `+layout.server` files above the route and the route's own `+page.server`.
 */
export function guardFileCandidates(r: FileRoute): { label: string; file: string }[] {
  const prefix = r.base ? `${r.base}/` : "";
  const out: { label: string; file: string }[] = [];
  const exts = ["ts", "js", "tsx", "jsx", "mjs"];
  const rootDir =
    r.framework === "sveltekit" ? "routes" : r.framework === "next-app" ? "app" : "pages";
  const special = r.framework === "sveltekit" ? ["hooks.server"] : ["middleware", "proxy"];
  for (const name of special)
    for (const e of exts) out.push({ label: name, file: `${prefix}${name}.${e}` });
  if (r.framework === "next-pages") return out;
  const layout = r.framework === "sveltekit" ? "+layout.server" : "layout";
  for (let depth = 0; depth <= r.dirs.length; depth++) {
    const dir = [rootDir, ...r.dirs.slice(0, depth)].join("/");
    for (const e of exts) out.push({ label: "layout", file: `${prefix}${dir}/${layout}.${e}` });
  }
  if (r.framework === "sveltekit" && r.methods.includes("PAGE")) {
    const dir = [rootDir, ...r.dirs].join("/");
    for (const e of ["ts", "js"])
      out.push({ label: "+page.server", file: `${prefix}${dir}/+page.server.${e}` });
  }
  return out;
}
