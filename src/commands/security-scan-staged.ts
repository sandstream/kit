import { sanitizeDisplayText } from "../display-text.js";
import { applyScanAllowlist } from "../scan-allow-run.js";
import { scanStagedFiles, type StagedHit } from "../scan-staged.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import type { FindingEvidence } from "../finding-evidence.js";

function displayEvidence(evidence: FindingEvidence): FindingEvidence {
  return { ...evidence, file: sanitizeDisplayText(evidence.file) || "[redacted path]" };
}

function describeHit(hit: StagedHit): string {
  const file = sanitizeDisplayText(hit.file) || "[redacted path]";
  if (hit.gap) return `${file}  ${hit.gap}`;
  const evidence = hit.findings
    .map(
      ({ evidence, preview }) =>
        `line ${evidence.line} ${evidence.pattern}:${sanitizeDisplayText(preview)}`,
    )
    .join(", ");
  return `${file}  ${evidence}`;
}

function printStagedHits(blocking: StagedHit[], advisory: StagedHit[]): void {
  if (advisory.length > 0) {
    console.error(
      `${c.dim}note: ${advisory.length} test/fixture file(s) contain secret-shaped strings (expected, not blocking):${c.reset}`,
    );
    for (const hit of advisory) console.error(`  ${c.dim}· ${describeHit(hit)}${c.reset}`);
    console.error(
      `${c.dim}  trufflehog locally and the CI gitleaks job still scan these and verify live.${c.reset}`,
    );
  }
  if (blocking.length === 0) return;
  const total = blocking.reduce((sum, hit) => sum + hit.findings.length, 0);
  console.error(`${c.red}✗ kit secret-scan blocked the commit${c.reset}`);
  if (total > 0) console.error(`${c.dim}Found ${total} potential secret(s).${c.reset}`);
  for (const hit of blocking) console.error(`  ${c.red}•${c.reset} ${describeHit(hit)}`);
  if (total > 0) {
    console.error(
      `\n${c.dim}For a false positive, add a reviewed [[scan.allow]] entry with a reason to .kit.toml. To move a secret to a vault, use kit secrets migrate.${c.reset}`,
    );
  }
}

export async function cmdSecurityScanStaged(): Promise<boolean> {
  const allowed = await applyScanAllowlist(await scanStagedFiles());
  const blocking = allowed.hits.filter((hit) => !hit.advisory);
  const ok = allowed.ok && blocking.length === 0;
  if (hasFlag(process.argv, "--json")) {
    console.log(
      JSON.stringify({
        ok,
        allowlistValid: allowed.ok,
        findings: allowed.hits.flatMap((hit) =>
          hit.findings.map((finding) => ({
            ...displayEvidence(finding.evidence),
            advisory: hit.advisory === true,
          })),
        ),
        gaps: allowed.hits.flatMap((hit) =>
          hit.gap
            ? [{ file: sanitizeDisplayText(hit.file) || "[redacted path]", detail: hit.gap }]
            : [],
        ),
        marks: allowed.used.flatMap(({ entry, evidence }) =>
          evidence.map((finding) => ({
            ...displayEvidence(finding),
            reason: sanitizeDisplayText(entry.reason),
          })),
        ),
      }),
    );
  } else if (allowed.ok) {
    printStagedHits(
      blocking,
      allowed.hits.filter((hit) => hit.advisory),
    );
  }
  return ok;
}
