/**
 * Provider-shaped keys in tracked files, for the `secrets scan` row when TruffleHog is missing.
 *
 * The Git-grep fallback looks for `api_key = "…"`-style assignments only, so an unquoted
 * `OPENAI_API_KEY=sk-proj-…` in a committed `AGENTS.md`, or a Stripe key inside a committed
 * `dist/*.js`, passed as "Git grep found no matches" while `kit security scan-staged` blocks the
 * same file. This reads tracked text files and applies kit's shared `SECRET_PATTERNS`, keeping
 * only the shapes that name one provider's credential by its prefix. The generic shapes (keyed
 * assignments, URL credentials, bearer headers) stay with the grep, which reports them unverified,
 * and so do two shapes that are public by design in client code: a JWT (Supabase's anon key) and
 * a Google `AIza` key (Firebase web config). A Stripe publishable key (`pk_`) is public too.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { skipsBasicScan } from "./basic-scan-skip.js";
import type { ScannerGap } from "./check-scanner-evidence.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { SECRET_PATTERNS } from "./utils/redactSecrets.js";

export interface ProviderSecretHit {
  file: string;
  labels: string[];
}

const NOT_PROVIDER_SHAPED = new Set([
  "kv-secret",
  "keyed-secret",
  "terraform-sensitive",
  "tfstate-value",
  "url-credentials",
  "url-token-userinfo",
  "url-query-token",
  "oauth-callback-code",
  "oauth-code-verifier",
  "bearer-header",
  "jwt",
  "google-api-key",
]);

const PROVIDER_PATTERNS = SECRET_PATTERNS.filter((p) => !NOT_PROVIDER_SHAPED.has(p.label));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;
/** Lists tracked text files with at least one run long enough to hold a key; the patterns decide. */
const CANDIDATE_RUN = "[A-Za-z0-9_+/=-]{16,}";

/** A value whose last 16 characters are one repeated character is a placeholder (`sk_test_AAAA…`). */
function isPlaceholder(raw: string): boolean {
  const tail = raw.slice(-16);
  return tail.length === 16 && tail.split("").every((ch) => ch === tail[0]);
}

function counts(label: string, raw: string): boolean {
  if (label === "stripe-key" && raw.startsWith("pk_")) return false;
  return !isPlaceholder(raw);
}

/** Pure: the provider-shaped labels the shared patterns find in one file's text. */
export function providerSecretLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const { re, label } of PROVIDER_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (counts(label, m[0])) labels.add(label);
    }
  }
  return [...labels].sort();
}

async function candidateFiles(root: string): Promise<{ files: string[]; gap?: ScannerGap }> {
  const args = ["grep", "--no-color", "--no-textconv", "--no-recurse-submodules", "-I", "-l"];
  const run = await execFileNoThrow("git", [...args, "-z", "-E", "-e", CANDIDATE_RUN, "--"], {
    timeout: 20_000,
    cwd: root,
  });
  const files = run.stdout.split("\0").filter(Boolean);
  if (run.ok || (run.exitCode === 1 && !run.stderr)) return { files };
  return {
    files,
    gap: { status: "partial", reason: "Git grep could not list every tracked file for key shapes" },
  };
}

async function readTracked(root: string, file: string): Promise<string | "oversize" | null> {
  try {
    const info = await lstat(join(root, file));
    if (!info.isFile()) return null;
    if (info.size > MAX_FILE_BYTES) return "oversize";
    return await readFile(join(root, file), "utf8");
  } catch {
    return null;
  }
}

function limitGap(oversize: number, capped: boolean): ScannerGap | undefined {
  const parts: string[] = [];
  if (oversize) parts.push(`${oversize} file(s) over ${MAX_FILE_BYTES} bytes were not read`);
  if (capped) parts.push(`only the first ${MAX_FILES} candidate files were read`);
  return parts.length ? { status: "partial", reason: parts.join("; ") } : undefined;
}

/**
 * Tracked working-tree files (test and fixture paths excluded, as in the grep fallback) that hold a
 * provider-shaped key, and a gap when part of the tree was not read.
 */
export async function scanTrackedProviderSecrets(
  root: string,
): Promise<{ hits: ProviderSecretHit[]; gap?: ScannerGap }> {
  const listed = await candidateFiles(root);
  const files = listed.files.filter((f) => !skipsBasicScan(f, ""));
  const hits: ProviderSecretHit[] = [];
  let oversize = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    const text = await readTracked(root, file);
    if (text === "oversize") oversize++;
    const labels =
      typeof text === "string" && text !== "oversize" ? providerSecretLabels(text) : [];
    if (labels.length) hits.push({ file, labels });
  }
  const gap = listed.gap ?? limitGap(oversize, files.length > MAX_FILES);
  return gap ? { hits, gap } : { hits };
}
