import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import {
  findSecrets,
  SECRET_PATTERNS,
  shannonEntropy,
  type SecretFinding,
} from "./utils/redactSecrets.js";

/**
 * Walks built-artifact directories looking for leaked credentials. The
 * typical failure mode this catches is a Next.js `NEXT_PUBLIC_` typo that
 * silently inlines a server-only secret into the client bundle.
 *
 * Intentionally narrow in scope:
 *   - only known build-output dirs (no full-repo walk — that's what
 *     scanStagedFiles + checkSecretsInCode do)
 *   - skips obvious binary extensions
 *   - bounded per-file read at 5 MiB so a giant minified blob doesn't
 *     stall the scan
 */
export interface BuildHit {
  file: string;
  findings: SecretFinding[];
}

const DEFAULT_BUILD_DIRS = [
  ".next",
  "dist",
  "build",
  "out",
  ".vercel/output",
  ".svelte-kit",
  ".nuxt",
  ".output",
];

const SCANNABLE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".html",
  ".css",
  ".json",
  ".map",
  ".txt",
  ".rsc",
  ".body",
  ".env",
  ".env.local",
  ".env.production",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm-store", "cache"]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

// Terraform / tfstate finding labels do not apply to build artifacts and
// false-positive on framework manifests — e.g. Next.js `routes-manifest.json`
// has many `"value":"…"` route entries that match the tfstate `"value"` rule.
// A build-artifact leak is an inlined CREDENTIAL (sk_/JWT/AWS/…), not an HCL or
// state construct, so these labels are filtered out here.
const BUILD_IRRELEVANT_LABELS = new Set(["tfstate-value", "terraform-sensitive"]);
const BUILD_GENERIC_LABELS = new Set(["keyed-secret", "url-query-token"]);
const OPAQUE_MIN_LENGTH = 20;
const OPAQUE_MIN_ENTROPY = 4.2;

function findBuildSecrets(content: string): SecretFinding[] {
  const findings = findSecrets(content).filter(
    (finding) =>
      !BUILD_IRRELEVANT_LABELS.has(finding.label) && !BUILD_GENERIC_LABELS.has(finding.label),
  );

  // Minified UI code routinely contains `key:"description"` and example URLs.
  // Generic names only justify a build failure when their values look opaque.
  for (const { re, label } of SECRET_PATTERNS) {
    if (!BUILD_GENERIC_LABELS.has(label)) continue;
    for (const match of content.matchAll(new RegExp(re.source, re.flags))) {
      const value = label === "keyed-secret" ? (match[3] ?? match[2]) : match[0].slice(match[1].length);
      if (value.length < OPAQUE_MIN_LENGTH || shannonEntropy(value) < OPAQUE_MIN_ENTROPY) continue;
      findings.push({ label, preview: "[REDACTED]" });
    }
  }

  return findings;
}

/** Next.js server modules are deployed to the runtime, not downloaded by visitors. */
function isBrowserVisibleNextArtifact(file: string): boolean {
  const parts = file.split("/");
  const nextIndex = parts.indexOf(".next");
  if (nextIndex === -1) return true;

  const output = parts.slice(nextIndex + 1);
  if (output[0] === "static") return true;
  if (output[0] !== "server" || !["app", "pages"].includes(output[1])) return false;

  // Prerendered responses in the server tree are served as page content.
  return /\.(?:html|rsc|body|json|txt)$/.test(file);
}

async function walk(dir: string, out: string[], depth = 0, maxDepth = 8): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out, depth + 1, maxDepth);
    } else if (ent.isFile()) {
      const ext = ent.name.includes(".") ? ent.name.slice(ent.name.lastIndexOf(".")) : "";
      if (!SCANNABLE_EXTS.has(ext) && !ent.name.startsWith(".env")) continue;
      out.push(full);
    }
  }
}

export async function scanBuildArtifacts(
  cwd: string = process.cwd(),
  customDirs?: string[],
): Promise<BuildHit[]> {
  const dirsToScan = customDirs ?? DEFAULT_BUILD_DIRS;
  const files: string[] = [];

  for (const d of dirsToScan) {
    const full = resolve(cwd, d);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(full, files);
  }

  const hits: BuildHit[] = [];
  for (const path of files) {
    const rel = relative(cwd, path).split(sep).join("/");
    if (!isBrowserVisibleNextArtifact(rel)) continue;
    let content: string;
    try {
      const st = await stat(path);
      if (st.size > MAX_BYTES) continue;
      content = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const findings = findBuildSecrets(content);
    if (findings.length > 0) {
      // Report repository-style paths so diagnostics and baselines are stable
      // across Windows and POSIX hosts.
      hits.push({ file: rel, findings });
    }
  }
  return hits;
}
