/**
 * kit — the single source of truth for the "is this project green?" verdict.
 *
 * `kit check` (CLI) and `kit_check` (MCP) both need to answer the SAME question:
 * given the tool/service/secret/skill/hook/security/test/lock results, is the
 * project ok? They used to answer it in two DIFFERENT places with two different
 * rules — the CLI applied the informational-service exemption, scanner-health-strict
 * security gating (`gateStatus`), and test-coverage; the MCP path used a naive
 * `every(authenticated)`, reduced security to `pass||skip`, and ignored tests
 * entirely. So the SAME repo state could read green on one surface and red on the
 * other — a structurally guaranteed false-green/false-red between the two agent
 * surfaces, the exact thing kit's "no false green" thesis condemns.
 *
 * This function is that rule, once. Pure, deterministic, zero-LLM. Both surfaces
 * call it; a test pins that they agree for a shared fixture.
 */
import { gateStatus, type SecurityCheckResult, type GateOpts } from "./check-security.js";

/** Minimal structural shapes — decoupled from the full check-result types so any
 *  caller can pass its results without importing every module's interface. */
export interface VerdictInputs {
  tools: { ok: boolean }[];
  services: { authenticated: boolean; informational?: boolean }[];
  secrets: { available: boolean }[];
  skills: { required: boolean; installed: boolean }[];
  hooks: { installed: boolean; upToDate: boolean }[];
  security: SecurityCheckResult[];
  tests: { status: "pass" | "fail" | "warn" | "skip" }[];
  locks: { inSync: boolean }[];
}

export type VerdictDimension = keyof VerdictInputs;

export interface CheckVerdict {
  /** True iff every dimension is ok. */
  ok: boolean;
  /** Per-dimension ok flag. */
  dimensions: Record<VerdictDimension, boolean>;
  /** The dimensions that are NOT ok — for a precise "red because: …" message. */
  failed: VerdictDimension[];
}

/**
 * Compute the overall green/ok verdict from all check dimensions. Mirrors the
 * historical `cmdCheck` rule exactly:
 *  - tools: every tool resolvable;
 *  - services: authenticated OR informational (manual-setup services are not a gate);
 *  - secrets: every configured key available;
 *  - skills: every REQUIRED skill installed (optional skills don't gate);
 *  - hooks: every git hook installed AND up to date;
 *  - security: every result non-fail under scanner-health-strict `gateStatus`
 *    (a check that could not RUN fails unless `lenient`);
 *  - tests: no test-coverage result is a hard fail;
 *  - locks: every lockfile in sync.
 */
export function computeCheckVerdict(input: VerdictInputs, opts: GateOpts = {}): CheckVerdict {
  const dimensions: Record<VerdictDimension, boolean> = {
    tools: input.tools.every((t) => t.ok),
    // Informational services (no CLI login — documented manual setup, e.g. resend
    // env keys) are not a failed gate; they surface as warnings elsewhere.
    services: input.services.every((s) => s.authenticated || s.informational === true),
    secrets: input.secrets.every((s) => s.available),
    skills: input.skills.filter((s) => s.required).every((s) => s.installed),
    hooks: input.hooks.every((h) => h.installed && h.upToDate),
    security: input.security.every((s) => gateStatus(s, opts) !== "fail"),
    tests: input.tests.every((t) => t.status !== "fail"),
    locks: input.locks.every((l) => l.inSync),
  };
  const failed = (Object.keys(dimensions) as VerdictDimension[]).filter((k) => !dimensions[k]);
  return { ok: failed.length === 0, dimensions, failed };
}
