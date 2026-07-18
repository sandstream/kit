/**
 * `kit broker` — the exec-broker runtime-posture surface (Pillar 3, observe→enforce adoption).
 *
 * Design: `kit-research/docs/research/exec-broker-enforce-adoption.md`.
 *
 * The runtime ladder is **off → observe → enforce**. observe runs the same gates but never
 * denies — it records each would-be denial to `.kit-audit.jsonl` (`metadata.phase === "observe"`,
 * `metadata.wouldDeny: string[]`). enforce requires `[scope].enforce_runtime = true` in the
 * SIGNED profile scope and actually denies. The gap is the human step between them: no evidence-
 * based way to answer "is it safe to flip to enforce?"
 *
 *   - `enforce-readiness` — read the observe evidence and turn the flip from a leap into a diff:
 *       `ready` (nothing observed would break), `would-block` (+ exactly what breaks), or the
 *       honest `untested` (no observe data — coverage is only what was observed, never a green).
 *
 * Reads the recorded audit log only — never executes anything. Deterministic, zero-LLM. The
 * guided `kit broker enforce` flip is a follow-up (E3). `--json` on every subcommand; `--gate`
 * turns a not-`ready` verdict into a non-zero exit for CI.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import {
  parseObserveRecords,
  assessEnforceReadiness,
  type EnforceReadiness,
} from "../exec-broker/enforce-readiness.js";

const AUDIT_FILE = ".kit-audit.jsonl";

/** Read the raw audit log; a missing/unreadable file is "" → parsed as zero observe records. */
function readAuditJsonl(cwd: string): string {
  try {
    return readFileSync(resolve(cwd, AUDIT_FILE), "utf-8");
  } catch {
    return "";
  }
}

function renderReadiness(r: EnforceReadiness): void {
  console.log(`${c.bold}kit broker enforce-readiness${c.reset}`);
  switch (r.verdict) {
    case "untested":
      console.log(
        `  ${c.yellow}! untested${c.reset} ${c.dim}— no observe data in ${AUDIT_FILE}. Run under observe first; a clean window is what makes enforce safe. Not a green "ready".${c.reset}`,
      );
      return;
    case "ready":
      console.log(
        `  ${c.green}✓ ready${c.reset} ${c.dim}— ${r.opsObserved} op(s) observed, none would be denied under enforce.${c.reset}`,
      );
      console.log(
        `  ${c.dim}coverage = observed ops only ("nothing we saw would break", not "nothing ever will").${c.reset}`,
      );
      return;
    case "would-block":
      console.log(
        `  ${c.red}✗ would-block${c.reset} ${c.dim}— ${r.wouldBlockOps} of ${r.opsObserved} observed op(s) would be denied under enforce:${c.reset}`,
      );
      for (const { reason, count } of r.reasons) {
        console.log(`    ${c.yellow}⚠${c.reset} ${c.bold}${count}×${c.reset}  ${reason}`);
      }
      console.log(
        `  ${c.dim}→ declare these in [scope] and re-sign, or accept the denials knowingly, before you flip.${c.reset}`,
      );
      return;
  }
}

async function brokerEnforceReadiness(jsonMode: boolean, gate: boolean): Promise<boolean> {
  const records = parseObserveRecords(readAuditJsonl(process.cwd()));
  const readiness = assessEnforceReadiness(records);
  if (jsonMode) {
    console.log(JSON.stringify({ gate, coverage: "observed-ops-only", ...readiness }, null, 2));
    return gate ? readiness.verdict === "ready" : true;
  }
  renderReadiness(readiness);
  // Informational by default; --gate makes a not-ready verdict fail CI (untested is not ready).
  return gate ? readiness.verdict === "ready" : true;
}

export async function cmdBroker(): Promise<boolean> {
  // A flag in the subcommand slot (`kit broker --json`) means "no subcommand" → default.
  const rawSub = process.argv[3];
  const sub = !rawSub || rawSub.startsWith("-") ? "enforce-readiness" : rawSub;
  const jsonMode = hasFlag(process.argv, "--json");
  if (sub === "enforce-readiness") {
    return await brokerEnforceReadiness(jsonMode, hasFlag(process.argv, "--gate"));
  }
  console.error(`${c.red}usage: kit broker <enforce-readiness> [--json] [--gate]${c.reset}`);
  return false;
}
