/**
 * What a project's own files say about its dependencies, for `dependency-surface.ts`.
 *
 * Two questions: which source files import each package, and which scripts, configs and workflows
 * could be running a tool that nothing imports. Both are text reads with caps. Nothing is parsed
 * into a syntax tree and nothing is run, so a dynamic specifier or a tool started from somewhere
 * else is invisible here, and the caller says so.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import type { ProjectManifest, SurfaceUsage } from "./dependency-surface.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".yarn",
  "vendor",
  "target",
  ".venv",
]);
const SOURCE = /\.(?:[mc]?[jt]sx?|vue|svelte)$/;
const STYLE = /\.(?:css|scss|sass|less)$/;
const STYLE_IMPORT =
  /@(?:import|plugin|config|use|forward|source)\s+(?:url\(\s*)?["']([^"']+)["']/g;
const TEST_FILE =
  /(?:^|[\\/])(?:tests?|__tests__|specs?|e2e)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-support\.[cm]?[jt]s$/;
const CONFIG_NAME =
  /^(?:\.[\w.-]*rc(?:\.\w+)?|[\w.-]*\.config\.\w+|\.eslintignore|\.prettierignore|Dockerfile|Makefile|tsconfig[\w.-]*\.json|\.npmrc|\.nvmrc)$/;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CONFIG_BYTES = 200_000;
const DEFAULT_MAX_FILES = 20_000;
/** Total source text read, so a huge tree cannot make a check run for minutes. */
export const DEFAULT_MAX_BYTES = 64_000_000;

const BUILTIN = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

/** The npm package a module specifier names, or null for a relative path, a built-in or a url. */
export function packageOfSpecifier(spec: string): string | null {
  if (!spec || /^[./#]/.test(spec) || spec.includes(":")) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || (spec.startsWith("@") && parts.length < 2)) return null;
  return BUILTIN.has(name) ? null : name;
}

const IMPORT_FORMS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** The package names a source text imports, by any of the static, dynamic or require forms. */
export function importedPackages(text: string): Set<string> {
  const found = new Set<string>();
  for (const form of IMPORT_FORMS) {
    for (const m of text.matchAll(form)) {
      const name = packageOfSpecifier(m[1]);
      if (name) found.add(name);
    }
  }
  return found;
}

/** The packages a stylesheet imports or loads as a plugin (`@import "tailwindcss"`, `@plugin "x"`). */
export function styleImportedPackages(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(STYLE_IMPORT)) {
    const spec = m[1].replace(/^~/, "");
    if (/\.(?:css|scss|sass|less)$/.test(spec)) continue;
    const name = packageOfSpecifier(spec);
    if (name) found.add(name);
  }
  return found;
}

async function walk(dir: string, files: string[], cap: number): Promise<boolean> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (files.length >= cap) return true;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (await walk(join(dir, entry.name), files, cap)) return true;
    } else if (entry.isFile() && (SOURCE.test(entry.name) || STYLE.test(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return false;
}

async function readCapped(path: string, cap: number): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile() || info.size > cap) return "";
  return readFile(path, "utf8").catch(() => "");
}

async function configText(root: string): Promise<string> {
  const texts: string[] = [];
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of top) {
    if (entry.isFile() && CONFIG_NAME.test(entry.name)) {
      texts.push(await readCapped(join(root, entry.name), MAX_CONFIG_BYTES));
    }
  }
  const workflows = join(root, ".github", "workflows");
  for (const entry of await readdir(workflows, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      texts.push(await readCapped(join(workflows, entry.name), MAX_CONFIG_BYTES));
    }
  }
  return texts.join("\n");
}

/**
 * Count the source files that import each package, and gather the text of scripts, configs and
 * workflows. Stops at `maxFiles` source files and says so in `truncated`.
 */
export async function scanSurfaceUsage(
  root: string,
  manifest: ProjectManifest,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): Promise<SurfaceUsage & { truncated: boolean; filesScanned: number }> {
  const cap = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  const truncated = await walk(root, files, cap);
  const importSites = new Map<string, number>();
  const productionImportSites = new Map<string, number>();
  const budget = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytes = 0;
  let overBudget = false;
  for (const file of files) {
    const text = await readCapped(file, MAX_FILE_BYTES);
    bytes += text.length;
    if (bytes > budget) {
      overBudget = true;
      break;
    }
    const production = !TEST_FILE.test(relative(root, file));
    const names = STYLE.test(file) ? styleImportedPackages(text) : importedPackages(text);
    for (const name of names) {
      importSites.set(name, (importSites.get(name) ?? 0) + 1);
      if (production) productionImportSites.set(name, (productionImportSites.get(name) ?? 0) + 1);
    }
  }
  const scripts = Object.values(manifest.scripts ?? {}).join("\n");
  return {
    importSites,
    productionImportSites,
    scriptText: `${scripts}\n${await configText(root)}`,
    truncated: truncated || overBudget,
    filesScanned: files.length,
  };
}
