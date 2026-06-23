/**
 * GitHub Actions hardening — static YAML lint (#60).
 *
 * Deterministic, local-first, no network, no YAML dep (line-scan). Flags the two
 * highest-signal CI supply-chain footguns:
 *   - unpinned action refs: `uses: owner/repo@v1` / `@main` instead of a full
 *     commit SHA (tj-actions/changed-files CVE-2025-30066, ~23k repos).
 *   - "pwn request": `pull_request_target` + `actions/checkout` (runs untrusted
 *     PR code with repo secrets).
 *
 * Pure analyzers (text → findings); `runGhaAudit` reads `.github/workflows/*`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const UNPINNED_RULE = {
  id: "CWE-1357", source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/1357.html",
  title: "Reliance on Insufficiently Trustworthy Component",
};
const PWN_RULE = {
  id: "OWASP-A08", source: "owasp" as const,
  ref: "https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/",
  title: "Software and Data Integrity Failures",
};

/** A 40-hex commit SHA is the only "pinned" ref. Tags/branches are unpinned. */
function isPinnedSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Lint one workflow file's text. Pure. */
export function auditWorkflow(content: string, file: string): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];

  const usesRe = /uses:\s*['"]?([A-Za-z0-9._\/-]+)@([^\s'"#]+)/g;
  const seen = new Set<string>();
  for (const m of content.matchAll(usesRe)) {
    const action = m[1];
    const ref = m[2];
    if (action.startsWith("./") || action.startsWith("docker://")) continue; // local / docker exempt
    if (isPinnedSha(ref)) continue; // pinned to a full SHA = good
    const key = `${action}@${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: "supply-chain",
      name: `unpinned action ${key} (${file})`,
      status: "warn",
      detail: `pin to a full commit SHA, not @${ref} — a moved tag can ship malicious code (CVE-2025-30066 class)`,
      severity: "medium",
      suggestion: `replace @${ref} with the action's full 40-char commit SHA`,
      rule: UNPINNED_RULE,
    });
  }

  if (/pull_request_target/.test(content) && /actions\/checkout/.test(content)) {
    out.push({
      category: "exposure",
      name: `pwn-request risk (${file})`,
      status: "warn",
      detail: "pull_request_target + actions/checkout can run untrusted PR code with repo secrets",
      severity: "high",
      suggestion: "avoid checking out PR head under pull_request_target, or gate on a label/permission",
      rule: PWN_RULE,
    });
  }

  return out;
}

/** Audit all workflows under .github/workflows. Read-only. */
export function runGhaAudit(cwd: string): SecurityCheckResult[] {
  const dir = resolve(cwd, ".github", "workflows");
  if (!existsSync(dir)) {
    return [{ category: "supply-chain", name: "gha-audit", status: "skip", detail: "no .github/workflows directory" }];
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return [{ category: "supply-chain", name: "gha-audit", status: "skip", detail: "could not read .github/workflows" }];
  }
  const out: SecurityCheckResult[] = [];
  for (const f of files) {
    try {
      out.push(...auditWorkflow(readFileSync(join(dir, f), "utf8"), f));
    } catch {
      // unreadable file → skip it (fail-open)
    }
  }
  if (out.length === 0) {
    out.push({ category: "supply-chain", name: "gha-audit", status: "pass", detail: `${files.length} workflow(s): all actions pinned, no pwn-request` });
  }
  return out;
}
