/**
 * `kit check` security row `browser scripts`: the third-party JavaScript a project ships to its
 * visitors' browsers. The install gate stops at `node_modules`; a `<script src>` in a page is a
 * dependency nothing else reads. Lists external scripts in HTML, templates and JSX, and flags
 * mutable CDN references, pinned CDN files without `integrity`, third-party code beside a card
 * form, and third-party code with no Content-Security-Policy anywhere in the repository.
 * Deterministic and bounded: no network, no model, capped file count and size.
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import {
  classifyScriptUrl,
  declaresCsp,
  extractScriptTags,
  hasPaymentForm,
  isExternalSrc,
  isPaymentProviderHost,
  type ScriptUrl,
} from "./browser-scripts-parse.js";

const BROWSER_SCRIPTS_NAME = "browser scripts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".turbo",
  "vendor",
  "bower_components",
  "target",
  "playwright-report",
  "test-results",
  "storybook-static",
]);
/** Scan bounds. Tests pass smaller ones. */
export interface BrowserScriptLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
}
const LIMITS: BrowserScriptLimits = { maxFiles: 5_000, maxFileBytes: 256 * 1024, maxDepth: 16 };
// Markup and templates: a skipped one may hide a script, so it makes the scan incomplete.
const MARKUP = /\.(?:html?|jsx|tsx|vue|svelte|astro|ejs|hbs|handlebars|njk|liquid)$/i;
// Code and header config: read for `<Script>` in .js and for a CSP; an oversized one is a bundle.
const CODE = /\.(?:[cm]?[jt]s)$/i;
const HEADER_CONFIG = new Set([
  "vercel.json",
  "netlify.toml",
  "_headers",
  "staticwebapp.config.json",
  "firebase.json",
]);
const TEST_DIR = /(?:^|\/)(?:__tests__|__mocks__|fixtures?)\//i;
const TEST_FILE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/i;
// Scripts in these files load on every page of a Next.js app.
const LAYOUT = /(?:^|\/)(?:pages\/_(?:document|app)|app\/layout)\.[cm]?[jt]sx?$/i;

interface Found {
  file: string;
  src: string;
  integrity: boolean;
  url: ScriptUrl;
}

/** What the scan saw. Exported for the row tests. */
export interface BrowserScriptInventory {
  scripts: Found[];
  paymentFiles: string[];
  csp: boolean;
  errors: string[];
}

function wanted(name: string, rel: string): boolean {
  if (TEST_DIR.test(rel) || TEST_FILE.test(rel)) return false;
  return MARKUP.test(name) || CODE.test(name) || HEADER_CONFIG.has(name);
}

function listFiles(root: string, limits: BrowserScriptLimits, errors: string[]): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) return void errors.push("depth limit reached");
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return void errors.push(`cannot list ${relative(root, dir).replaceAll("\\", "/") || "."}`);
    }
    for (const entry of entries) {
      if (files.length > limits.maxFiles) return;
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) visit(path, depth + 1);
      else if (entry.isFile() && wanted(entry.name, rel)) files.push(rel);
    }
  };
  visit(root, 0);
  files.sort();
  if (files.length > limits.maxFiles) {
    errors.push(`file limit reached (${limits.maxFiles})`);
    return files.slice(0, limits.maxFiles);
  }
  return files;
}

/** Read at most `max` bytes through one descriptor: no check-then-use on the path (CodeQL file race). */
function readBounded(root: string, rel: string, max: number, errors: string[]): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, rel), "r");
    const buf = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const n = readSync(fd, buf, size, max + 1 - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > max) {
      if (MARKUP.test(rel)) errors.push(`over ${Math.round(max / 1024)} KB: ${rel}`);
      return null;
    }
    return buf.toString("utf8", 0, size);
  } catch {
    errors.push(`cannot read ${rel}`);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function externalScripts(text: string, file: string): Found[] {
  const found: Found[] = [];
  for (const tag of extractScriptTags(text)) {
    if (!isExternalSrc(tag.src)) continue;
    const url = classifyScriptUrl(tag.src);
    if (url) found.push({ file, src: tag.src, integrity: tag.integrity, url });
  }
  return found;
}

/** Walk the root and collect every external script, every card-form file, and whether a CSP exists. */
export function inventoryBrowserScripts(
  root: string,
  limits: BrowserScriptLimits = LIMITS,
): BrowserScriptInventory {
  const inv: BrowserScriptInventory = { scripts: [], paymentFiles: [], csp: false, errors: [] };
  for (const file of listFiles(root, limits, inv.errors)) {
    const text = readBounded(root, file, limits.maxFileBytes, inv.errors);
    if (text === null) continue;
    if (!inv.csp && declaresCsp(text)) inv.csp = true;
    inv.scripts.push(...externalScripts(text, file));
    if (MARKUP.test(file) && hasPaymentForm(text)) inv.paymentFiles.push(file);
  }
  return inv;
}

const short = (items: string[], max = 3): string =>
  items.slice(0, max).join(", ") + (items.length > max ? `, +${items.length - max} more` : "");

// A page rendered by Next.js (not a static file in public/) also gets the layout's scripts.
const RENDERED_PAGE = /(?:^|\/)(?:pages|app)\/.+\.[cm]?[jt]sx?$/i;

function loadsOn(page: string, file: string): boolean {
  return file === page || (LAYOUT.test(file) && RENDERED_PAGE.test(page));
}

function paymentHits(inv: BrowserScriptInventory): string[] {
  const third = inv.scripts.filter((s) => !isPaymentProviderHost(s.url.host));
  const hits = new Set<string>();
  for (const page of inv.paymentFiles)
    for (const s of third.filter((x) => loadsOn(page, x.file)))
      hits.add(`${page}${s.file === page ? "" : ` (via ${s.file})`} loads ${s.url.host}`);
  return [...hits];
}

interface Findings {
  payment: string[];
  mutable: string[];
  noSri: string[];
  noCsp: number;
}

function findings(inv: BrowserScriptInventory): Findings {
  // A pinned file with integrity cannot change under the page, so CSP is asked of the others.
  const unhashed = inv.scripts.filter(
    (s) => !isPaymentProviderHost(s.url.host) && !(s.url.pin === "pinned" && s.integrity),
  );
  return {
    payment: paymentHits(inv),
    mutable: inv.scripts
      .filter((s) => s.url.pin === "mutable")
      .map((s) => `${s.file} ${s.url.host} ${s.url.reason}`),
    noSri: inv.scripts
      .filter((s) => s.url.pin === "pinned" && !s.integrity)
      .map((s) => `${s.file} ${s.url.host}`),
    noCsp: inv.csp ? 0 : new Set(unhashed.map((s) => s.url.host)).size,
  };
}

const FIX = {
  payment:
    "Move third-party scripts off pages with card fields, or take card data in the payment provider's hosted fields (iframe).",
  mutable: "Pin each CDN URL to an exact version (no @latest, no bare package, no @<major> range).",
  noSri: 'Add integrity="sha384-..." and crossorigin="anonymous" to pinned CDN scripts.',
  noCsp:
    "Add a Content-Security-Policy. SRI cannot pin a vendor snippet whose content changes; connect-src limits where it can send data.",
};

function findingRow(f: Findings): SecurityCheckResult | null {
  const parts: string[] = [];
  const fixes: string[] = [];
  const add = (key: keyof typeof FIX, count: number, text: string): void => {
    if (!count) return;
    parts.push(text);
    fixes.push(FIX[key]);
  };
  add("payment", f.payment.length, `third-party script beside a card form: ${short(f.payment)}`);
  add("mutable", f.mutable.length, `mutable CDN URL: ${short(f.mutable)}`);
  add("noSri", f.noSri.length, `pinned without integrity: ${short(f.noSri)}`);
  add("noCsp", f.noCsp, `no Content-Security-Policy found for ${f.noCsp} third-party origin(s)`);
  if (!parts.length) return null;
  const files = [
    ...new Set([...f.payment, ...f.mutable, ...f.noSri].map((x) => x.split(" ")[0] ?? x)),
  ];
  return {
    category: "supply-chain",
    name: BROWSER_SCRIPTS_NAME,
    status: f.payment.length ? "fail" : "warn",
    severity: f.payment.length ? "high" : f.mutable.length || f.noCsp ? "medium" : "low",
    detail: parts.join("; "),
    ...(files.length ? { files } : {}),
    suggestion: fixes.join(" "),
  };
}

function cleanDetail(inv: BrowserScriptInventory): string {
  const origins = new Set(inv.scripts.map((s) => s.url.host)).size;
  const n = inv.scripts.length;
  if (inv.scripts.every((s) => s.url.pin === "pinned" && s.integrity))
    return `${n} external script(s), all pinned with integrity`;
  return `${n} external script(s) from ${origins} origin(s)${inv.csp ? "; CSP found" : ""}`;
}

/** Judge an inventory into the single `browser scripts` row. */
function judgeBrowserScripts(inv: BrowserScriptInventory): SecurityCheckResult {
  const base = { category: "supply-chain" as const, name: BROWSER_SCRIPTS_NAME };
  const gap = inv.errors.length
    ? `${inv.errors.length} path(s) not scanned: ${short(inv.errors)}`
    : "";
  const row = findingRow(findings(inv));
  if (row) return gap ? { ...row, detail: `${row.detail}; ${gap}` } : row;
  if (gap) return { ...base, status: "warn", didNotRun: true, detail: gap };
  if (!inv.scripts.length)
    return { ...base, status: "skip", detail: "no external <script src> found" };
  return { ...base, status: "pass", detail: cleanDetail(inv) };
}

export async function checkBrowserScripts(root: string): Promise<SecurityCheckResult> {
  return judgeBrowserScripts(inventoryBrowserScripts(root));
}
