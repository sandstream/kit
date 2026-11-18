/**
 * What a project's own files say about its dependencies, for `dependency-surface.ts`.
 *
 * Two questions: which source files import each package, and which scripts, configs and workflows
 * could be running a tool that nothing imports. Both are text reads with caps. Nothing is parsed
 * into a syntax tree and nothing is run, so a dynamic specifier or a tool started from somewhere
 * else is invisible here, and the caller says so.
 */
import { open, readdir } from "node:fs/promises";
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
/** Longest the scan may spend reading source, so `kit check` is never held up by a slow disk. */
const DEFAULT_MAX_MILLIS = 8_000;
const READ_BATCH = 32;
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

/**
 * Read a file as text unless it is over `cap` bytes. The size is read from the open handle, not from
 * a separate stat, so the file that was measured is the file that is read.
 */
async function readCapped(path: string, cap: number): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > cap) return "";
    return await handle.readFile("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
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
/** Count one file's imports, and again as a production import when it is not a test file. */
function recordImports(
  file: string,
  text: string,
  relativePath: string,
  all: Map<string, number>,
  production: Map<string, number>,
): void {
  const names = STYLE.test(file) ? styleImportedPackages(text) : importedPackages(text);
  const isProduction = !TEST_FILE.test(relativePath);
  for (const name of names) {
    all.set(name, (all.get(name) ?? 0) + 1);
    if (isProduction) production.set(name, (production.get(name) ?? 0) + 1);
  }
}

export async function scanSurfaceUsage(
  root: string,
  manifest: ProjectManifest,
  opts: { maxFiles?: number; maxBytes?: number; maxMillis?: number } = {},
): Promise<SurfaceUsage & { truncated: boolean; filesScanned: number }> {
  const files: string[] = [];
  const listCapped = await walk(root, files, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const importSites = new Map<string, number>();
  const productionImportSites = new Map<string, number>();
  const byteBudget = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeBudget = opts.maxMillis ?? DEFAULT_MAX_MILLIS;
  const started = Date.now();
  let bytes = 0;
  let scanned = 0;
  let stopped = false;
  // Read in parallel batches: a cold disk is slow per file, not per byte. A budget on time and on
  // bytes keeps a huge tree from stalling the check that asked for the numbers.
  for (let i = 0; i < files.length && !stopped; i += READ_BATCH) {
    if (Date.now() - started >= timeBudget) break;
    const batch = files.slice(i, i + READ_BATCH);
    const texts = await Promise.all(batch.map((file) => readCapped(file, MAX_FILE_BYTES)));
    for (let j = 0; j < batch.length; j++) {
      bytes += texts[j].length;
      if (bytes > byteBudget) {
        stopped = true;
        break;
      }
      scanned++;
      recordImports(
        batch[j],
        texts[j],
        relative(root, batch[j]),
        importSites,
        productionImportSites,
      );
    }
  }
  const scripts = Object.values(manifest.scripts ?? {}).join("\n");
  return {
    importSites,
    productionImportSites,
    scriptText: `${scripts}\n${await configText(root)}`,
    truncated: listCapped || scanned < files.length,
    filesScanned: scanned,
  };
}
