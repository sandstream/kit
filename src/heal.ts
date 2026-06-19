/**
 * `kit heal` — bounded self-heal loop.
 *
 * Auto-applies the SAFE, deterministic, reversible fixes for `kit check`
 * findings and re-scans until green, while two classes are deliberately NOT
 * auto-healed:
 *   - GATED: destructive/outward fixes (secret rotation, history purge,
 *     propagate, `npm audit fix`). heal PROPOSES the exact command; the human
 *     or agent runs it, hitting the existing elevation gate + audit log. heal
 *     never calls elevation itself.
 *   - FAIL-CLOSED: a supply-chain checksum mismatch may be tampering, so heal
 *     refuses and alerts — auto-clearing+re-downloading would mask an attack.
 *
 * Zero-LLM: heal classifies + applies deterministic fixers and emits proposals.
 * The `--agent` surface is just structured proposals for an external agent to
 * run; no model is embedded.
 */
import { checkSecurity, type SecurityCheckResult } from "./check-security.js";
import { installTools } from "./install.js";
import { patchGitignore } from "./check-gitignore.js";
import { syncSecurityFindings, actionableFindings } from "./findings-track.js";

export type HealClass = "safe" | "gated" | "fail-closed";

export interface GatedFinding {
  name: string;
  issue: string;
  action: string;
}

export interface HealResult {
  /** dedup keys (category:name) of findings that were auto-fixed and cleared. */
  healed: string[];
  /** findings heal proposes but will never auto-run (destructive/outward). */
  gated: GatedFinding[];
  /** tamper-suspect findings heal refuses to touch. */
  failClosed: SecurityCheckResult[];
  /** dry-run only: what WOULD be auto-fixed. */
  plannedSafe: string[];
  iterations: number;
}

const dedupKey = (r: SecurityCheckResult): string => `${r.category}:${r.name}`;

/** A checksum/integrity mismatch is a tamper signal — never auto-healed. */
export function isFailClosed(r: SecurityCheckResult): boolean {
  if (r.status !== "fail") return false;
  const s = `${r.detail} ${r.suggestion ?? ""}`.toLowerCase();
  return s.includes("checksum mismatch") || s.includes("do not trust");
}

/**
 * A SAFE, deterministic, reversible fixer for this finding, or null. Two
 * recipes cover the common cases; anything unmatched stays gated/manual (safe
 * default = don't auto-touch).
 */
export function safeRecipe(r: SecurityCheckResult): (() => Promise<void>) | null {
  if (isFailClosed(r)) return null;
  // A missing scanner/tool whose suggestion is `mise use <ref>` → install it.
  const m = r.suggestion?.match(/mise use (\S+)/);
  if (m) {
    const ref = m[1];
    return async () => {
      await installTools({ [ref]: "latest" });
    };
  }
  // A .gitignore missing a sensitive pattern → patch it (idempotent, reversible).
  if (/gitignore/i.test(`${r.name} ${r.detail}`)) {
    return async () => {
      await patchGitignore();
    };
  }
  return null;
}

export function classify(r: SecurityCheckResult): HealClass {
  if (isFailClosed(r)) return "fail-closed";
  return safeRecipe(r) ? "safe" : "gated";
}

function toGated(r: SecurityCheckResult): GatedFinding {
  return { name: r.name, issue: r.detail, action: r.suggestion ?? "see `kit check`" };
}

/**
 * Run the heal loop. Re-scans after each round of safe fixes; PAL auto-close
 * confirms a finding cleared. Bounded by `maxIterations` and a no-progress
 * guard (a safe fix that doesn't clear its finding is not retried).
 */
export async function runHeal(opts: { dryRun?: boolean; maxIterations?: number } = {}): Promise<HealResult> {
  const max = opts.maxIterations ?? 3;
  const tried = new Set<string>();
  let gated: GatedFinding[] = [];
  let failClosed: SecurityCheckResult[] = [];
  let plannedSafe: string[] = [];
  let iterations = 0;
  let appliedAny = false;
  let lastResults: SecurityCheckResult[] = [];

  for (let i = 0; i < max; i++) {
    iterations = i + 1;
    lastResults = await checkSecurity();
    await syncSecurityFindings(lastResults); // track + auto-close (fail-open)

    const actionable = actionableFindings(lastResults);
    failClosed = actionable.filter(isFailClosed);
    gated = actionable.filter((r) => classify(r) === "gated").map(toGated);

    // Fail-closed findings are EXCLUDED from auto-heal (safeRecipe returns null
    // for them) and surfaced loudly — but they don't block applying unrelated,
    // integrity-independent safe fixes (e.g. patching .gitignore). The tamper-
    // suspect binary is never trusted/run; halting everything on a flaky scanner
    // checksum would make heal unusable.
    const toApply = actionable.filter((r) => classify(r) === "safe" && !tried.has(dedupKey(r)));
    if (toApply.length === 0) break; // converged: nothing new to safely fix

    if (opts.dryRun) {
      plannedSafe = toApply.map(dedupKey);
      break;
    }

    for (const r of toApply) {
      tried.add(dedupKey(r));
      try {
        await safeRecipe(r)!();
        appliedAny = true;
      } catch {
        // leave it — the next re-scan will still surface it
      }
    }
  }

  // Confirm the final state when we changed anything (loop applies then the next
  // iteration scans; a final scan covers fixes applied in the last iteration).
  if (appliedAny && !opts.dryRun) {
    lastResults = await checkSecurity();
    await syncSecurityFindings(lastResults);
    const actionable = actionableFindings(lastResults);
    failClosed = actionable.filter(isFailClosed);
    gated = actionable.filter((r) => classify(r) === "gated").map(toGated);
  }

  const finalActionable = new Set(actionableFindings(lastResults).map(dedupKey));
  const healed = [...tried].filter((k) => !finalActionable.has(k));
  return { healed, gated, failClosed, plannedSafe, iterations };
}
