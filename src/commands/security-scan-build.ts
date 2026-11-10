import { c } from "../utils/colors.js";
import {
  BuildScanIncompleteError,
  scanBuildArtifacts,
  type BuildScanReport,
} from "../scan-build.js";
import { SECRET_SHAPE_COUNT } from "../utils/redactSecrets.js";
import { isTestArtifact } from "../check-client-exposure.js";

export async function cmdSecurityScanBuild(): Promise<boolean> {
  // Optional positional: extra dirs to scan beyond the defaults.
  const extras = process.argv.slice(4).filter((a) => !a.startsWith("--"));
  const includeTests = process.argv.includes("--include-tests");
  const include = (file: string) => includeTests || !isTestArtifact(file);
  let hits: Awaited<ReturnType<typeof scanBuildArtifacts>>;
  let incomplete = false;
  const report: BuildScanReport = { skipped: {} };
  try {
    hits = await scanBuildArtifacts(process.cwd(), extras.length > 0 ? extras : undefined, report);
  } catch (error) {
    if (!(error instanceof BuildScanIncompleteError)) throw error;
    const issue = error.issues.find((item) => include(item.file));
    if (issue) {
      incomplete = true;
      console.error(`${c.red}✗ scan-build: incomplete: ${issue.detail}${c.reset}`);
    }
    hits = error.hits;
  }
  hits = hits.filter((hit) => include(hit.file));
  if (incomplete && hits.length === 0) return false;
  if (hits.length === 0) {
    // The denominator belongs in the claim: "no patterns found" reads as "no secrets there", and
    // the honest statement is "none of the shapes kit knows".
    console.log(
      `${c.green}✓ scan-build: no matches for ${SECRET_SHAPE_COUNT} known credential shapes${c.reset}${c.dim}. Kit cannot detect other credential shapes.${c.reset}`,
    );
    printSkipped(report);
    return true;
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(
    `${c.red}✗ scan-build: ${total} potential secret(s) in ${hits.length} build file(s):${c.reset}`,
  );
  for (const hit of hits.slice(0, 20)) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  if (hits.length > 20) {
    console.error(`  ${c.dim}… and ${hits.length - 20} more${c.reset}`);
  }
  printSkipped(report);
  console.error(
    `\n${c.dim}Typical cause: a server-only env var (e.g. STRIPE_SECRET_KEY) is referenced via NEXT_PUBLIC_* and got inlined into the client bundle. Rebuild after fixing.${c.reset}`,
  );
  return false;
}

/**
 * The files the scan did not read, by type. A green line covers only what was read, and a
 * binary in a build dir (an installer, a native module) can still carry a key.
 */
export function skippedLine(skipped: Record<string, number>): string | null {
  const rows = Object.entries(skipped).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) return null;
  const total = rows.reduce((n, [, k]) => n + k, 0);
  const shown = rows.slice(0, 8).map(([ext, k]) => `${ext} ×${k}`);
  if (rows.length > 8) shown.push(`${rows.length - 8} more type(s)`);
  return `Not read: ${total} file(s) by type (${shown.join(", ")}). A credential inside them is not covered.`;
}

function printSkipped(report: BuildScanReport): void {
  const line = skippedLine(report.skipped);
  if (line) console.log(`${c.dim}${line}${c.reset}`);
}
