// `kit gha-audit` command — extracted from cli.ts (incremental split).
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";

export async function cmdGhaAudit(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const { runGhaAudit } = await import("../gha-audit.js");
  const { runCiAudit } = await import("../ci-audit.js");
  const results = [...runGhaAudit(process.cwd()), ...runCiAudit(process.cwd())];
  const fails = results.filter((r) => r.status === "fail").length;

  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, results }, null, 2));
    return fails === 0;
  }

  console.log(
    `${c.bold}kit gha-audit${c.reset}  ${c.dim}CI hardening: GitHub Actions + GitLab/Bitbucket${c.reset}`,
  );
  for (const r of results) {
    const mark =
      r.status === "fail"
        ? `${c.red}✗${c.reset}`
        : r.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : r.status === "skip"
            ? `${c.dim}−${c.reset}`
            : `${c.green}✓${c.reset}`;
    console.log(`  ${mark} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.suggestion) console.log(`      ${c.dim}${r.suggestion}${c.reset}`);
  }
  return fails === 0;
}
