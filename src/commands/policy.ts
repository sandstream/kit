// `kit policy` — manage the signable org policy document (3.0 Phase 1).
//
// init/show/validate operate on `.kit-policy.toml`; sign/verify tie the policy to
// a `kit identity` (Phase 0) so an org's standard is cryptographically attributable
// and offline-verifiable. Distinct from `.kit.toml [policy.agent_writes]` (the 2.x
// per-repo agent-write pre-approval) — this is the org-level standard.
import { existsSync, writeFileSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import {
  getPolicyPath,
  getPolicySigPath,
  loadPolicy,
  validatePolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  verifyPolicy,
  POLICY_TEMPLATE,
  type PolicyDoc,
  type PolicySignature,
} from "../policy-doc.js";
import { evaluatePolicy, formatPolicyEval } from "../policy-check.js";
import { tryLoadIdentity, signWithIdentity } from "../identity.js";

export async function cmdPolicy(): Promise<boolean> {
  const sub = process.argv[3] ?? "show";
  const root = getCurrentProjectRoot();
  switch (sub) {
    case "init":
      return policyInit(root);
    case "show":
      return policyShow(root);
    case "validate":
      return policyValidate(root);
    case "sign":
      return policySign(root);
    case "verify":
      return policyVerify(root);
    case "check":
      return policyCheck(root);
    default:
      console.error(`${c.red}usage: kit policy <init|show|validate|sign|verify|check>${c.reset}`);
      return false;
  }
}

function policyInit(root: string): boolean {
  const path = getPolicyPath(root);
  if (existsSync(path) && !hasFlag(process.argv, "--force")) {
    console.error(`${c.red}${path} already exists${c.reset} — pass --force to overwrite`);
    return false;
  }
  writeFileSync(path, POLICY_TEMPLATE, "utf-8");
  console.log(`${c.green}✓${c.reset} wrote ${c.bold}${path}${c.reset}`);
  console.log(
    `${c.dim}edit it, then ${c.reset}${c.bold}kit policy sign${c.reset}${c.dim} to attribute it to your identity${c.reset}`,
  );
  return true;
}

function loadOrReport(root: string): PolicyDoc | null {
  const doc = loadPolicy(root);
  if (!doc) {
    console.error(
      `${c.red}no policy at ${getPolicyPath(root)}${c.reset} — run ${c.bold}kit policy init${c.reset}`,
    );
  }
  return doc;
}

function policyShow(root: string): boolean {
  const doc = loadOrReport(root);
  if (!doc) return false;
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify(doc));
    return true;
  }
  console.log(`${c.bold}kit policy${c.reset}  ${c.dim}${policyFingerprint(doc)}${c.reset}`);
  for (const [k, v] of Object.entries(doc)) {
    console.log(`  ${k} ${c.dim}=${c.reset} ${JSON.stringify(v)}`);
  }
  return true;
}

function policyValidate(root: string): boolean {
  const doc = loadOrReport(root);
  if (!doc) return false;
  const r = validatePolicy(doc);
  if (r.ok) {
    console.log(`${c.green}✓ policy valid${c.reset}  ${c.dim}${policyFingerprint(doc)}${c.reset}`);
    return true;
  }
  console.error(`${c.red}✗ policy invalid:${c.reset}`);
  for (const e of r.errors) console.error(`  ${c.red}-${c.reset} ${e}`);
  return false;
}

function policySign(root: string): boolean {
  const doc = loadOrReport(root);
  if (!doc) return false;
  // Refuse to sign an invalid policy — a signature must vouch for a sound doc.
  const v = validatePolicy(doc);
  if (!v.ok) {
    console.error(`${c.red}✗ refusing to sign an invalid policy:${c.reset}`);
    for (const e of v.errors) console.error(`  ${c.red}-${c.reset} ${e}`);
    return false;
  }
  const identity = tryLoadIdentity();
  if (!identity) {
    console.error(
      `${c.red}no identity to sign with${c.reset} — run ${c.bold}kit identity init${c.reset}`,
    );
    return false;
  }
  const bytes = canonicalPolicyBytes(doc);
  const record: PolicySignature = {
    kid: identity.id,
    sig: signWithIdentity(bytes).toString("base64"),
    ts: new Date().toISOString(),
    fingerprint: policyFingerprint(doc),
  };
  writeFileSync(getPolicySigPath(root), JSON.stringify(record, null, 2) + "\n", "utf-8");
  console.log(
    `${c.green}✓${c.reset} signed ${c.bold}${record.fingerprint}${c.reset} as ${c.bold}${identity.id}${c.reset} ${c.dim}→ ${getPolicySigPath(root)}${c.reset}`,
  );
  console.log(
    `${c.dim}commit .kit-policy.toml + .kit-policy.sig; verifiers check it with the public key (kit identity show --public)${c.reset}`,
  );
  return true;
}

function policyVerify(root: string): boolean {
  const doc = loadOrReport(root);
  if (!doc) return false;
  const r = verifyPolicy(root, { key: flagValue(process.argv, "--key") ?? undefined });
  switch (r.status) {
    case "valid":
      console.log(
        `${c.green}✓ policy signature valid${c.reset}  ${c.dim}${r.fingerprint} ${r.detail}${c.reset}`,
      );
      return true;
    case "unverifiable":
      console.warn(`${c.yellow}! ${r.detail}${c.reset}`);
      return true; // trust-absence ≠ a forge; fail-open like audit verify
    case "unsigned":
      console.error(`${c.red}${r.detail}${c.reset}`);
      return false;
    case "invalid":
      console.error(`${c.red}✗ policy signature INVALID${c.reset} ${c.dim}(${r.detail})${c.reset}`);
      return false;
    case "revoked":
      console.error(
        `${c.red}✗ policy signed by a REVOKED key${c.reset} ${c.dim}(${r.detail}) — re-sign with the current identity${c.reset}`,
      );
      return false;
  }
}

async function policyCheck(root: string): Promise<boolean> {
  const doc = loadPolicy(root);
  if (!doc) {
    console.log(
      `${c.dim}no policy at ${getPolicyPath(root)} — nothing to enforce (run ${c.reset}${c.bold}kit policy init${c.reset}${c.dim})${c.reset}`,
    );
    return true; // policy is opt-in; absent = no-op
  }
  const strict = hasFlag(process.argv, "--strict");
  const report = await evaluatePolicy(root, { strict });
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify(report));
    return report.ok;
  }
  console.log(formatPolicyEval(report));
  return report.ok;
}
