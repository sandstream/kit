/**
 * kit policy enforcement — evaluate `.kit-policy.toml` against the machine's
 * actual, deterministically-checkable state (3.0 Phase 1, part 2).
 *
 * The signed policy (policy-doc.ts) says WHAT the org standard is; this module
 * checks whether reality matches it: is the policy authentic (signature), is kit
 * new enough, are the required scanners present, does `.kit.toml` express the
 * required approval gate. Requirements whose enforcement lives elsewhere (the
 * install-gate, a data-source plugin) are surfaced honestly rather than
 * re-implemented. Deterministic, zero-LLM, fail-open when no policy is present.
 */
import { join } from "node:path";
import { loadPolicy, validatePolicy, verifyPolicy } from "./policy-doc.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { getKitVersionSync } from "./update-check.js";
import { loadConfig } from "./config.js";
import { c } from "./utils/colors.js";

export type PolicyEvalStatus = "pass" | "warn" | "fail" | "n/a";

export interface PolicyEvalItem {
  requirement: string;
  status: PolicyEvalStatus;
  detail: string;
}

export interface PolicyEvalReport {
  present: boolean;
  /** Signature verdict as an eval item (pass/warn/fail). Omitted when no policy. */
  signature?: PolicyEvalItem;
  items: PolicyEvalItem[];
  ok: boolean;
}

/** current ≥ required, comparing dotted numeric segments. Pure. */
export function versionGte(current: string, required: string): boolean {
  const a = current.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const b = required.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true; // equal
}

/**
 * Evaluate the policy at `root`. Returns `present:false` (ok) when no policy
 * exists — policy is opt-in, so its absence enforces nothing. A hard failure
 * (`ok:false`) is: a tampered/revoked signature, an invalid schema, an unmet
 * `min_kit_version`, or — under `strict` — a missing required scanner.
 */
export async function evaluatePolicy(
  root: string,
  opts: { strict?: boolean } = {},
): Promise<PolicyEvalReport> {
  const doc = loadPolicy(root);
  if (!doc) return { present: false, items: [], ok: true };

  const items: PolicyEvalItem[] = [];

  // Signature is the trust anchor — an unsigned/unknown signer is a warn (the
  // policy still reads), a tampered/revoked one is a hard fail.
  const v = verifyPolicy(root);
  const sigStatus: PolicyEvalStatus =
    v.status === "valid"
      ? "pass"
      : v.status === "invalid" || v.status === "revoked"
        ? "fail"
        : "warn";
  const signature: PolicyEvalItem = {
    requirement: "signature",
    status: sigStatus,
    detail: v.detail,
  };

  // Schema — an invalid policy can't be meaningfully enforced.
  const val = validatePolicy(doc);
  if (!val.ok) {
    items.push({ requirement: "schema", status: "fail", detail: val.errors.join("; ") });
  }

  // min_kit_version — fully deterministic.
  if (doc.min_kit_version) {
    const cur = getKitVersionSync();
    const ok = versionGte(cur, doc.min_kit_version);
    items.push({
      requirement: "min_kit_version",
      status: ok ? "pass" : "fail",
      detail: `requires ≥ ${doc.min_kit_version}, have ${cur}`,
    });
  }

  // required_scanners — presence is deterministic (mise-first resolution).
  for (const scanner of doc.required_scanners ?? []) {
    let present = false;
    try {
      present = Boolean(await resolveToolBin(scanner));
    } catch {
      present = false;
    }
    items.push({
      requirement: `scanner:${scanner}`,
      status: present ? "pass" : opts.strict ? "fail" : "warn",
      detail: present ? "installed" : "not installed (kit install provisions declared tools)",
    });
  }

  // Config-expressed requirements — read .kit.toml governance (best-effort).
  let cfg: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    cfg = await loadConfig(join(root, ".kit.toml"));
  } catch {
    /* no/!parseable .kit.toml — the config-expressed items report "not enforced" */
  }
  if (doc.prod_writes_need_approval) {
    const on = cfg?.governance?.approval?.production_writes === true;
    items.push({
      requirement: "prod_writes_need_approval",
      status: on ? "pass" : "warn",
      detail: on
        ? "[governance.approval].production_writes = true"
        : "not set in .kit.toml [governance.approval]",
    });
  }
  if (doc.require_triage) {
    // Enforced at runtime by the install-gate; surface it rather than duplicate.
    items.push({
      requirement: "require_triage",
      status: "pass",
      detail: "enforced by the install-gate (kit triage / agent-config --install-gate)",
    });
  }
  if (doc.thresholds && Object.keys(doc.thresholds).length > 0) {
    items.push({
      requirement: "thresholds",
      status: "n/a",
      detail: `${Object.keys(doc.thresholds).join(", ")} — enforced by the relevant data-source plugin (e.g. CodeScene)`,
    });
  }

  const hardFail = sigStatus === "fail" || items.some((i) => i.status === "fail");
  return { present: true, signature, items, ok: !hardFail };
}

const ICON: Record<PolicyEvalStatus, string> = {
  pass: `${c.green}✓${c.reset}`,
  warn: `${c.yellow}!${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
  "n/a": `${c.dim}·${c.reset}`,
};

/** Human-readable rendering of an eval report. */
export function formatPolicyEval(report: PolicyEvalReport): string {
  if (!report.present) return `${c.dim}no policy to enforce${c.reset}`;
  const lines: string[] = [];
  lines.push(`${c.bold}kit policy check${c.reset}`);
  if (report.signature) {
    lines.push(
      `  ${ICON[report.signature.status]} signature  ${c.dim}${report.signature.detail}${c.reset}`,
    );
  }
  for (const it of report.items) {
    lines.push(`  ${ICON[it.status]} ${it.requirement}  ${c.dim}${it.detail}${c.reset}`);
  }
  lines.push(
    report.ok
      ? `${c.green}✓ policy satisfied${c.reset}`
      : `${c.red}✗ policy NOT satisfied${c.reset}`,
  );
  return lines.join("\n");
}
