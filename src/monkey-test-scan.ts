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

const SOURCE_LITERAL = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/;
const SOURCE_TEMPLATE_LITERAL = /`(?:\\.|[^`\\])*`/;

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

export function detectPaymentProviders(
  deps: Record<string, string>,
  source: string | Record<string, string>,
): string[] {
  const providers = new Set<string>();
  const depNames = Object.keys(deps).join("\n");
  const sourceText =
    typeof source === "string"
      ? stripSourceComments(source)
      : Object.values(withoutMonkeySourceComments(source)).join("\n");
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

function sourceCommentPattern(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".sql") return /--[^\n]*|\/\*[\s\S]*?\*\//.source;
  if ([".py", ".rb", ".toml", ".yaml", ".yml"].includes(ext)) return /#[^\n]*/.source;
  if (ext === ".json") return "(?!)";
  const slash = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/.source;
  return ext === ".php" ? `${slash}|#[^\\n]*` : slash;
}

interface CommentCursor {
  text: string;
  offset: number;
  tokens: RegExp;
  parts: string[];
}

function blankComment(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function copyTemplate(cursor: CommentCursor): void {
  while (cursor.offset < cursor.text.length) {
    const char = cursor.text[cursor.offset++];
    cursor.parts.push(char);
    if (char === "\\") {
      cursor.parts.push(cursor.text.slice(cursor.offset, cursor.offset + 1));
      cursor.offset++;
    } else if (char === "`") {
      return;
    } else if (char === "$" && cursor.text[cursor.offset] === "{") {
      cursor.parts.push("{");
      cursor.offset++;
      copyCodeWithoutComments(cursor, true);
    }
  }
}

function copyCodeWithoutComments(cursor: CommentCursor, interpolation = false): void {
  let depth = 1;
  while (cursor.offset < cursor.text.length) {
    cursor.tokens.lastIndex = cursor.offset;
    const match = cursor.tokens.exec(cursor.text);
    if (!match) {
      cursor.parts.push(cursor.text.slice(cursor.offset));
      cursor.offset = cursor.text.length;
      return;
    }
    cursor.parts.push(cursor.text.slice(cursor.offset, match.index));
    const token = match[0];
    cursor.offset = cursor.tokens.lastIndex;
    cursor.parts.push(match[2] === undefined ? token : blankComment(token));
    if (token === "`") copyTemplate(cursor);
    if (!interpolation) continue;
    if (token === "{") depth++;
    if (token === "}" && --depth === 0) return;
  }
}

function stripHtmlComments(text: string): string {
  // Script bodies have JavaScript strings/templates; prose apostrophes do not open strings.
  const tokens = /<!--[\s\S]*?(?:-->|$)|<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)|<[^>]*>/gi;
  return text.replace(tokens, (token) => {
    if (token.startsWith("<!--")) return blankComment(token);
    if (!/^<script\b/i.test(token)) return token;
    const start = token.indexOf(">") + 1;
    const closing = token.search(/<\/script\s*>$/i);
    const end = closing < 0 ? token.length : closing;
    return token.slice(0, start) + stripSourceComments(token.slice(start, end)) + token.slice(end);
  });
}

function stripSourceComments(text: string, path = "source.js"): string {
  if (extname(path).toLowerCase() === ".html") return stripHtmlComments(text);
  const javascript = /\.[cm]?[jt]sx?$/i.test(path);
  const literals = javascript
    ? SOURCE_LITERAL.source
    : `${SOURCE_LITERAL.source}|${SOURCE_TEMPLATE_LITERAL.source}`;
  const syntax = javascript ? "|[`{}]" : "";
  const cursor: CommentCursor = {
    text,
    offset: 0,
    tokens: new RegExp(`(${literals})|(${sourceCommentPattern(path)})${syntax}`, "gm"),
    parts: [],
  };
  copyCodeWithoutComments(cursor);
  return cursor.parts.join("");
}

export function withoutMonkeySourceComments(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, stripSourceComments(text, path)]),
  );
}

export function hasAnyMonkeyFile(files: Record<string, string>, patterns: RegExp[]): boolean {
  return Object.values(files).some((text) => patterns.some((pattern) => pattern.test(text)));
}
