import { c } from "../utils/colors.js";
import { BuildScanIncompleteError, scanBuildArtifacts } from "../scan-build.js";
import { SECRET_SHAPE_COUNT } from "../utils/redactSecrets.js";

export async function cmdSecurityScanBuild(): Promise<boolean> {
  // Optional positional: extra dirs to scan beyond the defaults.
  const extras = process.argv.slice(4).filter((a) => !a.startsWith("--"));
  let hits: Awaited<ReturnType<typeof scanBuildArtifacts>>;
  try {
    hits = await scanBuildArtifacts(process.cwd(), extras.length > 0 ? extras : undefined);
  } catch (error) {
    if (!(error instanceof BuildScanIncompleteError)) throw error;
    console.error(`${c.red}✗ scan-build: incomplete: ${error.message}${c.reset}`);
    hits = error.hits;
    if (hits.length === 0) return false;
  }
  if (hits.length === 0) {
    // The denominator belongs in the claim: "no patterns found" reads as "no secrets there", and
    // the honest statement is "none of the shapes kit knows".
    console.log(
      `${c.green}✓ scan-build: no matches for ${SECRET_SHAPE_COUNT} known credential shapes${c.reset}${c.dim}. Kit cannot detect other credential shapes.${c.reset}`,
    );
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
  console.error(
    `\n${c.dim}Typical cause: a server-only env var (e.g. STRIPE_SECRET_KEY) is referenced via NEXT_PUBLIC_* and got inlined into the client bundle. Rebuild after fixing.${c.reset}`,
  );
  return false;
}
