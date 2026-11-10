/**
 * GitHub Actions hardening — static YAML lint (#60).
 *
 * Deterministic, local-first, no network, no YAML dep (line-scan). Flags the two
 * highest-signal CI supply-chain footguns, plus a gate that can skip itself green
 * (src/gha-skip-gate.ts):
 *   - unpinned action refs: `uses: owner/repo@v1` / `@main` instead of a full
 *     commit SHA (tj-actions/changed-files CVE-2025-30066, ~23k repos).
 *   - "pwn request": a privileged trigger (`pull_request_target`, `workflow_run`,
 *     `issue_comment`) plus a step that brings pull-request code in (src/gha-pwn.ts).
 *   - `pull_request_target`, which GitHub blocks in public repositories from 2026-12-02 unless
 *     an Actions event policy allows it.
 *
 * Pure analyzers (text → findings); `runGhaAudit` reads `.github/workflows/*`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { auditSkippableGates } from "./gha-skip-gate.js";
import { PRT_DEFAULT_BLOCK_DATE, pwnRequest, workflowTriggers } from "./gha-pwn.js";

const UNPINNED_RULE = {
  id: "CWE-1357",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/1357.html",
  title: "Reliance on Insufficiently Trustworthy Component",
};
const PWN_RULE = {
  id: "OWASP-A08",
  source: "owasp" as const,
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

  out.push(...pwnRows(content, file));

  out.push(...auditSkippableGates(content, file));
  return out;
}

/** The pwn-request finding and the default-block notice for one workflow. Pure. */
function pwnRows(content: string, file: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  const pwn = pwnRequest(content);
  if (pwn) {
    rows.push({
      category: "exposure",
      name: `pwn-request risk (${file})`,
      status: "warn",
      detail: `${pwn.trigger} runs with the repository's secrets and write token, and this workflow brings in pull-request code: ${pwn.shapes.join("; ")}`,
      severity: "high",
      suggestion:
        "use pull_request for anything that runs PR code, or keep the PR code as data that no step executes; gate the privileged job on a label or maintainer approval",
      rule: PWN_RULE,
    });
  }
  if (workflowTriggers(content).includes("pull_request_target")) {
    rows.push({
      category: "supply-chain",
      name: `pull_request_target default block (${file})`,
      status: "warn",
      severity: "low",
      detail: `GitHub blocks pull_request_target in public repositories from ${PRT_DEFAULT_BLOCK_DATE} unless an Actions event policy allows it for this workflow; kit has not read this repository's visibility or policies`,
      suggestion:
        "switch to pull_request if the workflow needs no secrets; otherwise allow this file in an Actions event policy (Settings → Actions → Policies) after checking it never runs PR code",
    });
  }
  return rows;
}

/** Audit all workflows under .github/workflows. Read-only. */
export function runGhaAudit(cwd: string): SecurityCheckResult[] {
  const dir = resolve(cwd, ".github", "workflows");
  if (!existsSync(dir)) {
    return [
      {
        category: "supply-chain",
        name: "gha-audit",
        status: "skip",
        detail: "no .github/workflows directory",
      },
    ];
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return [
      {
        category: "supply-chain",
        name: "gha-audit",
        status: "skip",
        detail: "could not read .github/workflows",
      },
    ];
  }
  const out: SecurityCheckResult[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      unreadable.push(f); // do NOT silently skip — an unread workflow must not be reported clean
      continue;
    }
    out.push(...auditWorkflow(text, f));
  }
  if (unreadable.length > 0) {
    // Scanner-health: a workflow we could not read was NOT audited, so we must not emit the
    // blanket "all pinned" pass over it (that would be a false green for a supply-chain scanner).
    out.push({
      category: "supply-chain",
      name: "gha-audit",
      status: "warn",
      severity: "medium",
      detail: `could not read ${unreadable.length} workflow(s): ${unreadable.join(", ")} — not audited`,
    });
  } else if (out.length === 0) {
    out.push({
      category: "supply-chain",
      name: "gha-audit",
      status: "pass",
      detail: `${files.length} workflow(s): all actions pinned, no pwn-request, no skippable gate`,
    });
  }
  return out;
}
