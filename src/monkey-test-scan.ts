import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { MonkeyPackageJson } from "./monkey-test-contract.js";

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".php",
  ".java",
  ".kt",
  ".cs",
  ".html",
  ".toml",
  ".json",
  ".yaml",
  ".yml",
  ".md",
]);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  "vendor",
  "tmp",
  "test-results",
  "playwright-report",
]);

const SOURCE_LITERAL_OR_COMMENT =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|^[ \t]*#[^\n]*)/gm;

export interface MonkeySourceScan {
  text: string;
  files: Record<string, string>;
  runtimeText: string;
  runtimeFiles: Record<string, string>;
}

export async function readMonkeyJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function readMonkeyText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export function allMonkeyDependencies(pkg: MonkeyPackageJson | null): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

export function detectPaymentProviders(deps: Record<string, string>, sourceText: string): string[] {
  const providers = new Set<string>();
  const depNames = Object.keys(deps).join("\n");
  if (/\bstripe\b|@stripe\//i.test(depNames)) providers.add("stripe");
  if (/\badyen\b/i.test(depNames)) providers.add("adyen");
  if (/\bpaypal\b|braintree/i.test(depNames)) providers.add("paypal");
  if (/\bsquare\b/i.test(depNames)) providers.add("square");
  if (
    /from\s+["']stripe["']|require\(["']stripe["']\)|@stripe\/|new\s+Stripe\(|loadStripe\(|js\.stripe\.com|stripe\.webhooks\.constructEvent/i.test(
      sourceText,
    )
  )
    providers.add("stripe");
  if (
    /from\s+["']@adyen\/|require\(["']@adyen\/|(?:new\s+)?AdyenCheckout\(|checkoutshopper-[a-z-]+\.adyen\.com/i.test(
      sourceText,
    )
  )
    providers.add("adyen");
  if (
    /paypal\.com\/sdk\/js|from\s+["']@paypal\/|require\(["']@paypal\/|braintree\.(client|dropin|hostedFields)|new\s+Braintree/i.test(
      sourceText,
    )
  )
    providers.add("paypal");
  if (
    /connect\.squareupsandbox\.com|connect\.squareup\.com|from\s+["']@square\/|require\(["']@square\/|new\s+Square/i.test(
      sourceText,
    )
  )
    providers.add("square");
  return [...providers].sort();
}

function isRuntimeSourcePath(path: string): boolean {
  if (
    path.startsWith("docs/") ||
    path.startsWith("skills/") ||
    path.startsWith("contracts/") ||
    path.startsWith(".kit/") ||
    path.includes("/tests/") ||
    path.includes("/__tests__/") ||
    path.includes("/fixtures/") ||
    path.includes("/mocks/")
  )
    return false;
  if (/(^|\/)(test|tests|fixtures|mocks)\//i.test(path)) return false;
  if (/\.(test|spec|fixture|mock|snapshot)\.[cm]?[jt]sx?$/i.test(path)) return false;
  if (path.endsWith(".md")) return false;
  return true;
}

async function candidateFiles(cwd: string, maxFiles = 500): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [cwd];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;
      out.push(join(dir, entry.name));
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

export async function scanMonkeySources(cwd: string): Promise<MonkeySourceScan> {
  const files: Record<string, string> = {};
  const runtimeFiles: Record<string, string> = {};
  const chunks: string[] = [];
  const runtimeChunks: string[] = [];
  for (const file of await candidateFiles(cwd)) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (info.size > 512 * 1024) continue;
    const text = await readMonkeyText(file);
    const rel = relative(cwd, file).split("\\").join("/");
    files[rel] = text;
    chunks.push(`\n--- ${rel} ---\n${text}`);
    if (isRuntimeSourcePath(rel)) {
      runtimeFiles[rel] = text;
      runtimeChunks.push(`\n--- ${rel} ---\n${text}`);
    }
  }
  return {
    text: chunks.join("\n"),
    files,
    runtimeText: runtimeChunks.join("\n"),
    runtimeFiles,
  };
}

export function firstMonkeyFileMatching(
  files: Record<string, string>,
  pattern: RegExp,
): string | undefined {
  return Object.entries(files).find(([, text]) => pattern.test(text))?.[0];
}

function stripSourceComments(text: string): string {
  return text.replace(SOURCE_LITERAL_OR_COMMENT, (token, literal: string | undefined) =>
    literal === undefined ? token.replace(/[^\n]/g, "") : literal,
  );
}

export function withoutMonkeySourceComments(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, stripSourceComments(text)]),
  );
}

export function hasAnyMonkeyFile(files: Record<string, string>, patterns: RegExp[]): boolean {
  return Object.values(files).some((text) => patterns.some((pattern) => pattern.test(text)));
}
