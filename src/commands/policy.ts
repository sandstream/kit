// `kit policy` — manage the signable org policy document (3.0 Phase 1).
//
// init/show/validate operate on `.kit-policy.toml`; sign/verify tie the policy to
// a `kit identity` (Phase 0) so an org's standard is cryptographically attributable
// and offline-verifiable. Distinct from `.kit.toml [policy.agent_writes]` (the 2.x
// per-repo agent-write pre-approval) — this is the org-level standard.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import {
  addPolicySigner,
  loadPolicySigners,
  removePolicySigner,
  getSignersPath,
} from "../policy-trust.js";
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
import { pullPolicy } from "../policy-pull.js";
import { pullRevocations } from "../revocation-pull.js";
import { extractRbac } from "../rbac/policy-schema.js";
import { mintApprovalToken, APPROVAL_TOKENS_FILE } from "../approval-tokens.js";
import { identityId } from "../identity.js";
import {
  resolveKeyStore,
  assertHardwareIdentity,
  isHardwareRooted,
  hardwareRequired,
} from "../keystore/index.js";

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
    case "trust":
      return policyTrust(root);
    case "pull":
      return policyPull(root);
    case "pull-revocations":
      return policyPullRevocations(root);
    case "approve":
      return policyApprove(root);
    default:
      console.error(
        `${c.red}usage: kit policy <init|show|validate|sign|verify|check|trust|pull|pull-revocations|approve>${c.reset}`,
      );
      return false;
  }
}

/**
 * `kit policy approve <operation> [--env <env>] [--ttl <seconds>]` — mint a signed, time-boxed
 * approval token for an operation, signed by this identity. Honored offline by `requestApproval`
 * ONLY if this identity is in the verifier's `.kit-policy.signers` org trust anchor (fail-closed).
 * Distribute the token like any other signed artifact (commit / pull channel).
 */
function policyApprove(root: string): boolean {
  const operation = process.argv[4];
  if (!operation || operation.startsWith("-")) {
    console.error(
      `${c.red}usage: kit policy approve <operation> [--env <env>] [--ttl <seconds>]${c.reset}`,
    );
    return false;
  }
  const environment = flagValue(process.argv, "--env") ?? "prod";
  const ttl = Number(flagValue(process.argv, "--ttl") ?? "3600");
  if (!Number.isFinite(ttl) || ttl <= 0) {
    console.error(`${c.red}--ttl must be a positive number of seconds${c.reset}`);
    return false;
  }
  try {
    const tk = mintApprovalToken(operation, environment, ttl, { root });
    console.log(
      `${c.green}✓${c.reset} minted approval for ${c.bold}${operation}${c.reset} ${c.dim}(env ${environment}, expires ${tk.expires}) as ${tk.kid} → ${join(root, APPROVAL_TOKENS_FILE)}${c.reset}`,
    );
    console.log(
      `${c.dim}honored offline only if ${tk.kid} is in the verifier's .kit-policy.signers anchor; distribute/commit ${APPROVAL_TOKENS_FILE}${c.reset}`,
    );
    return true;
  } catch (e) {
    console.error(`${c.red}✗ approve failed: ${(e as Error).message}${c.reset}`);
    return false;
  }
}

/**
 * `kit policy pull <source>` — fetch an org-signed policy from a self-hostable source (a local
 * path or `file://` dir holding `.kit-policy.toml` + `.kit-policy.sig`) and apply it ONLY if it
 * verifies offline against this project's LOCAL `.kit-policy.signers` anchor. Fail-closed: anything
 * short of a valid signature keeps the existing policy. The trust anchor is never fetched.
 */
function policyPull(root: string): boolean {
  const source = process.argv[4];
  if (!source) {
    console.error(
      `${c.red}usage: kit policy pull <source>${c.reset} ${c.dim}(a local path or file:// dir with .kit-policy.toml + .kit-policy.sig)${c.reset}`,
    );
    return false;
  }
  const r = pullPolicy(source, root);
  if (r.ok) {
    console.log(
      `${c.green}✓${c.reset} ${r.detail}  ${c.dim}${r.fingerprint ?? ""} → ${getPolicyPath(root)}${c.reset}`,
    );
    // Fleet-RBAC distributes IN the signed policy (§4.4). Surface what arrived so the operator sees
    // the roles/bindings were distributed — best-effort; never changes the pull verdict.
    try {
      const rbac = extractRbac(loadPolicy(root));
      if (rbac) {
        console.log(
          `${c.dim}distributed RBAC: ${Object.keys(rbac.roles).length} role(s), ${rbac.bindings.length} binding(s)${rbac.defaultRole ? `, default role ${rbac.defaultRole}` : ""}${c.reset}`,
        );
      }
    } catch {
      /* best-effort summary only */
    }
    console.log(
      `${c.dim}verify anytime with ${c.reset}${c.bold}kit policy verify${c.reset}${c.dim}; commit the applied .kit-policy.toml + .kit-policy.sig${c.reset}`,
    );
    return true;
  }
  const hint =
    r.status === "no-anchor"
      ? " — add trusted org keys with `kit policy trust add` (committed out of band)"
      : r.status === "no-source"
        ? ""
        : " — the source policy is unsigned, tampered, or signed by an untrusted/revoked key";
  console.error(`${c.red}✗ policy pull failed${c.reset} ${c.dim}(${r.detail})${c.reset}${hint}`);
  return false;
}

/**
 * `kit policy pull-revocations <source>` — fetch a signed `revocations.jsonl` feed from a
 * self-hostable source and monotone-merge the AUTHORITATIVE records (valid signature by an org
 * trust-anchor signer, or a self-revoke) into the local append-only log. Add-only: it can only add
 * revocations, never un-revoke one. Non-authoritative records are dropped and counted.
 */
function policyPullRevocations(root: string): boolean {
  const source = process.argv[4];
  if (!source) {
    console.error(
      `${c.red}usage: kit policy pull-revocations <source>${c.reset} ${c.dim}(a local path or file:// dir with revocations.jsonl)${c.reset}`,
    );
    return false;
  }
  const r = pullRevocations(source, root);
  if (r.ok) {
    console.log(
      `${c.green}✓${c.reset} ${r.detail}${r.rejected ? ` ${c.dim}(unauthorized records ignored — fail-closed)${c.reset}` : ""}`,
    );
    return true;
  }
  const hint =
    r.status === "no-anchor"
      ? " — add trusted org keys with `kit policy trust add` (committed out of band)"
      : "";
  console.error(
    `${c.red}✗ pull-revocations failed${c.reset} ${c.dim}(${r.detail})${c.reset}${hint}`,
  );
  return false;
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
  // Sign through the resolved keystore, not the file key directly: this is what lets a
  // hardware-rooted (command/TPM/enclave) backend sign the org policy, and what makes
  // a hardware mandate enforceable. Falls back to the file backend unchanged by default.
  const res = resolveKeyStore();
  const pub = res.store.publicKeyPem();
  if (!pub) {
    console.error(
      `${c.red}no identity to sign with${c.reset} — ` +
        (res.availability.ok
          ? `run ${c.bold}kit identity init${c.reset}`
          : (res.availability.reason ?? "keystore unavailable")),
    );
    return false;
  }
  // Fail closed if a hardware-rooted identity is mandated (env OR this policy's own
  // require_hardware_identity) but the active backend isn't one — never sign the org's
  // standard with a same-UID key.
  try {
    assertHardwareIdentity(res, hardwareRequired(root));
  } catch (e) {
    console.error(`${c.red}✗ ${(e as Error).message}${c.reset}`);
    return false;
  }
  const kid = identityId(pub);
  const bytes = canonicalPolicyBytes(doc);
  let sigB64: string;
  try {
    sigB64 = res.store.sign(bytes).toString("base64");
  } catch (e) {
    console.error(`${c.red}✗ signing failed: ${(e as Error).message}${c.reset}`);
    return false;
  }
  const record: PolicySignature = {
    kid,
    sig: sigB64,
    ts: new Date().toISOString(),
    fingerprint: policyFingerprint(doc),
  };
  writeFileSync(getPolicySigPath(root), JSON.stringify(record, null, 2) + "\n", "utf-8");
  const rootedNote = isHardwareRooted(res)
    ? ` ${c.dim}(${res.store.kind}, hardware-rooted)${c.reset}`
    : "";
  console.log(
    `${c.green}✓${c.reset} signed ${c.bold}${record.fingerprint}${c.reset} as ${c.bold}${kid}${c.reset}${rootedNote} ${c.dim}→ ${getPolicySigPath(root)}${c.reset}`,
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

function policyTrust(root: string): boolean {
  // List the org trust anchor.
  if (
    hasFlag(process.argv, "--list") ||
    (!process.argv[4] && !flagValue(process.argv, "--remove"))
  ) {
    const signers = loadPolicySigners(root);
    if (!signers.length) {
      console.log(
        `${c.dim}no org trust anchor — add one with ${c.reset}${c.bold}kit policy trust <pubkey.pem> [--label <name>]${c.reset}`,
      );
      return true;
    }
    console.log(
      `${c.bold}${signers.length}${c.reset} trusted policy signer(s) ${c.dim}(${getSignersPath(root)})${c.reset}`,
    );
    for (const s of signers) {
      console.log(`  ${c.bold}${s.id}${c.reset}${s.label ? ` ${c.dim}${s.label}${c.reset}` : ""}`);
    }
    return true;
  }
  // Remove a signer by id.
  const removeId = flagValue(process.argv, "--remove");
  if (removeId) {
    const ok = removePolicySigner(root, removeId);
    console.log(
      ok
        ? `${c.green}✓${c.reset} removed ${removeId} from the trust anchor`
        : `${c.dim}${removeId} not in the trust anchor${c.reset}`,
    );
    return ok;
  }
  // Add a signer from an SPKI-PEM file (e.g. produced by `kit identity show --public`).
  const file = process.argv[4];
  if (!existsSync(file)) {
    console.error(`${c.red}no such public-key file: ${file}${c.reset}`);
    return false;
  }
  try {
    const pem = readFileSync(file, "utf-8");
    const r = addPolicySigner(root, pem, flagValue(process.argv, "--label") ?? undefined);
    if (r.added) {
      console.log(
        `${c.green}✓${c.reset} trusted org policy signer ${c.bold}${r.signer.id}${c.reset}${r.signer.label ? ` ${c.dim}(${r.signer.label})${c.reset}` : ""}`,
      );
      console.log(
        `${c.dim}commit .kit-policy.signers — any clone now verifies a policy this org key signed; an untrusted signer fails ${c.reset}${c.bold}kit policy check${c.reset}${c.dim}/${c.reset}${c.bold}kit ci${c.reset}`,
      );
    } else {
      console.log(`${c.dim}${r.signer.id} ${r.reason}${c.reset}`);
    }
    return true;
  } catch (err) {
    console.error(`${c.red}not a valid public key: ${(err as Error).message}${c.reset}`);
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
