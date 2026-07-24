import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { kitConfig } from "./config.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { activeKeyStoreStatus, hardwareRequired } from "./keystore/active.js";
import { existsSync } from "node:fs";
import { profileBrokerPolicy } from "./exec-broker/profile-policy.js";
import { verifyProfileSignature } from "./profile/sign.js";
import { verifyPolicy, loadPolicy, getPolicyPath } from "./policy-doc.js";
import { extractRbac } from "./rbac/policy-schema.js";
import { tryLoadIdentity, isRevoked } from "./identity.js";
import type { ContainmentVerdict } from "./containment.js";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  category: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: number;
  warnings: number;
  failed: number;
}

async function checkNodeVersion(cwd: string): Promise<DoctorCheck> {
  const name = "Node.js version";
  const category = "runtime";

  try {
    const pkgJson = await readFile(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgJson) as { engines?: { node?: string } };
    const required = pkg?.engines?.node;

    if (!required) {
      return { name, status: "skip", detail: "No engines.node in package.json", category };
    }

    const current = process.version; // "v22.22.2"
    const currentMajor = parseInt(current.replace("v", "").split(".")[0], 10);

    const match = required.match(/(\d+)/);
    const requiredMajor = match ? parseInt(match[1], 10) : null;

    if (requiredMajor === null) {
      return { name, status: "skip", detail: `Cannot parse engines.node: ${required}`, category };
    }

    if (currentMajor >= requiredMajor) {
      return { name, status: "pass", detail: `${current} (requires ${required})`, category };
    } else {
      return { name, status: "fail", detail: `${current} does not satisfy ${required}`, category };
    }
  } catch {
    return { name, status: "skip", detail: "No package.json found", category };
  }
}

async function checkMise(): Promise<DoctorCheck> {
  const name = "mise";
  const category = "tooling";

  try {
    const { stdout } = await execFileAsync("mise", ["--version"]);
    const version = stdout.trim();
    return { name, status: "pass", detail: `installed (${version})`, category };
  } catch {
    return {
      name,
      status: "warn",
      detail: "mise not found — tool installation will not work",
      category,
    };
  }
}

async function checkMisePath(): Promise<DoctorCheck | null> {
  const { miseShimsDir, isDirOnPath, activationLine } = await import("./mise-path.js");
  const shims = miseShimsDir();
  try {
    await access(shims);
  } catch {
    return null; // no mise shims here → nothing to check
  }
  if (isDirOnPath(process.env.PATH, shims)) {
    return { name: "mise tools on PATH", status: "pass", detail: shims, category: "tools" };
  }
  return {
    name: "mise tools on PATH",
    status: "warn",
    detail: `mise shims not on PATH — bare commands (snyk/trivy/infisical/…) won't resolve. Add to your shell profile: ${activationLine(shims)}`,
    category: "tools",
  };
}

async function checkEnvLocal(config: kitConfig, cwd: string): Promise<DoctorCheck | null> {
  if (!config.secrets) return null;

  const name = ".env.local";
  const category = "secrets";
  const envPath = join(cwd, ".env.local");

  try {
    await access(envPath);
    return { name, status: "pass", detail: ".env.local exists", category };
  } catch {
    return {
      name,
      status: "warn",
      detail: ".env.local not found (run: kit secrets)",
      category,
    };
  }
}

async function checkToolsInPath(config: kitConfig): Promise<DoctorCheck[]> {
  if (!config.tools) return [];

  const checks: DoctorCheck[] = [];

  for (const toolName of Object.keys(config.tools)) {
    const name = `${toolName} resolvable`;
    const category = "tools";

    // resolveToolBin is mise-first (`mise which`), so it finds tools installed via
    // `mise use -g` even when mise isn't activated and its shims aren't on PATH —
    // before falling back to a system PATH lookup.
    const bin = await resolveToolBin(toolName);
    if (bin) {
      checks.push({ name, status: "pass", detail: bin, category });
    } else {
      checks.push({
        name,
        status: "warn",
        detail: "not found (run: kit install)",
        category,
      });
    }
  }

  return checks;
}

async function checkKitWrapper(): Promise<DoctorCheck | null> {
  const { kitWrapperPath, WRAPPER_MARKER } = await import("./kit-wrapper.js");
  const path = kitWrapperPath();
  const name = "hook wrapper";
  const category = "hooks";
  try {
    await access(path);
  } catch {
    return {
      name,
      status: "warn",
      detail: `${path} missing — hooks may fail in a non-login shell. Run: kit memory install`,
      category,
    };
  }
  const content = await readFile(path, "utf-8").catch(() => "");
  if (!content.includes(WRAPPER_MARKER)) {
    return { name, status: "warn", detail: `${path} exists but is not kit-managed`, category };
  }
  return { name, status: "pass", detail: path, category };
}

async function checkMemoryHooks(): Promise<DoctorCheck | null> {
  const { memoryHooksLiveness } = await import("./memory/install.js");
  const name = "memory hooks";
  const category = "hooks";
  const live = memoryHooksLiveness();
  if (!live.everInstalled) return null; // never installed here → nothing to verify
  if (live.missing.length === 0) {
    return { name, status: "pass", detail: `${live.present.length} wired`, category };
  }
  // Installed once, but a hook has since vanished — capture is silently off.
  return {
    name,
    status: "fail",
    detail: `installed but missing from settings.json: ${live.missing.join(", ")} — memory capture is silently off. Run: kit memory install`,
    category,
  };
}

async function checkGitHooks(config: kitConfig): Promise<DoctorCheck[]> {
  if (!config.hooks) return [];

  const { checkHooks, isGitRepository } = await import("./check-hooks.js");

  if (!isGitRepository()) {
    return [
      {
        name: "git hooks",
        status: "skip",
        detail: "not a git repository",
        category: "hooks",
      },
    ];
  }

  const hookResults = await checkHooks(config.hooks);
  return hookResults.map((h) => ({
    name: h.hookName,
    category: "hooks",
    status: (!h.installed ? "fail" : !h.upToDate ? "warn" : "pass") as DoctorCheckStatus,
    detail: h.detail,
  }));
}

/**
 * Identity KeyStore posture (Pillar 1). Surfaces WHICH backend signs kit's
 * identity and — per the 5.0 design principle — makes any degradation to
 * the file-backed 0600 key HONEST rather than silent:
 *   pass  hardware-rooted (Secure Enclave / TPM / external command)
 *   warn  file-backed 0600 key (the working default; no hardware backend active)
 *   fail  hardware REQUIRED (KIT_REQUIRE_HARDWARE / policy) but unavailable —
 *         fail-closed, the same posture keystoreSign enforces at sign time.
 */
function checkIdentityKeystore(): DoctorCheck {
  const name = "identity keystore";
  const category = "security";
  const st = activeKeyStoreStatus();
  const required = hardwareRequired();

  if (required && !st.hardwareRooted) {
    return {
      name,
      status: "fail",
      detail: `hardware identity required but unavailable — ${st.reason ?? "no hardware backend"} (signing is fail-closed)`,
      category,
    };
  }
  if (st.hardwareRooted && st.available) {
    return {
      name,
      status: "pass",
      detail: `hardware-rooted: ${st.kind}${st.kid ? ` (${st.kid})` : ""}`,
      category,
    };
  }
  // File-backed default — accepted, but surfaced (never silent).
  return {
    name,
    status: "warn",
    detail: `file-backed key (0600)${st.kid ? ` (${st.kid})` : ""} — no hardware backend active; migrate with 'kit identity' or require one via KIT_REQUIRE_HARDWARE`,
    category,
  };
}

/**
 * Exec-broker scope posture (Pillar 3). Surfaces the state of the signed [scope]/RoE the
 * broker enforces against — per the design principle, "enforced" must never silently mean
 * "no-op" and a degradation is surfaced, never swallowed:
 *   pass  scope declared + signature verified (this scope governs)
 *   skip  no profile / no [scope] declared — nothing to enforce yet
 *   warn  scope declared but unsigned/unverifiable — grants nothing (fail-closed)
 *   fail  signature invalid/revoked or profile malformed — grants nothing (fail-closed)
 */
async function checkBrokerScope(cwd: string): Promise<DoctorCheck> {
  const name = "exec-broker scope";
  const category = "security";
  // The canonical broker's signed-scope provider (reconciliation R4): one source for the gates,
  // the governance floor, AND this posture line — there is one broker, not two.
  const { regime, policy, detail } = await profileBrokerPolicy(cwd);
  if (regime === "none") {
    return {
      name,
      status: "skip",
      detail: `${detail} — declare [scope] in .kit-profile.toml and run 'kit profile sign' to arm the exec-broker`,
      category,
    };
  }
  if (policy) {
    return { name, status: "pass", detail, category };
  }
  // Declared but untrustworthy (policy null). Preserve the honest warn-vs-fail split: a
  // never-signed scope is a WARN (just sign it); a tampered/revoked/malformed one is a FAIL.
  const status = await scopeDegradationStatus(cwd);
  if (status === "warn") {
    return { name, status: "warn", detail: `${detail}; run 'kit profile sign'`, category };
  }
  return { name, status: "fail", detail, category };
}

/** Distinguish an unsigned (warn) scope from an invalid/revoked/malformed (fail) one. */
async function scopeDegradationStatus(cwd: string): Promise<"warn" | "fail"> {
  try {
    const v = await verifyProfileSignature(cwd);
    return v.status === "unsigned" || v.status === "unverifiable" ? "warn" : "fail";
  } catch {
    return "fail"; // a broken artifact must never read as a mere warning
  }
}

/**
 * Exec-broker MCP-RUNTIME mediation posture (Pillar 3 adoption). The scope row above says whether a
 * signed scope EXISTS; this says whether the RUNTIME actually mediates governed MCP ops against it —
 * "delivered but not opted in" must never read as "enforcing":
 *   skip  enforce_runtime not set — the runtime is NOT mediating (opt in with `[scope].enforce_runtime = true`)
 *   pass  enforce_runtime set + scope verified — governed MCP ops are mediated against the signed scope
 *   fail  enforce_runtime set + scope unsigned/tampered — opted in but untrustworthy: governed ops fail-closed-denied
 */
/** Read the recorded audit log for the observe→enforce nudge; "" when absent/unreadable. */
async function readAuditLog(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, ".kit-audit.jsonl"), "utf-8");
  } catch {
    return "";
  }
}

async function checkBrokerRuntime(cwd: string): Promise<DoctorCheck> {
  const name = "exec-broker runtime";
  const category = "security";
  const { runtimeMode, policy, regime } = await profileBrokerPolicy(cwd);
  if (runtimeMode === "off") {
    // Default-on: a declared scope mediates in observe by default, so "off" means either no scope is
    // declared here, or the scope explicitly opted OUT with enforce_runtime = false.
    return {
      name,
      status: "skip",
      detail:
        regime === "none"
          ? "no [scope] declared — nothing to mediate at the MCP runtime"
          : "MCP-runtime mediation explicitly OFF ([scope].enforce_runtime = false); remove it to get observe-by-default, or set true to enforce",
      category,
    };
  }
  if (runtimeMode === "observe") {
    // Dry-run: never denies. warn (not pass) — mediation is not actually protecting yet; the point is
    // to read the would-be denials in the audit trail, then graduate to enforce.
    if (!policy) {
      return {
        name,
        status: "warn",
        detail:
          "runtime OBSERVE mode but the scope is unsigned/invalid — every declared op would be denied under enforce; run 'kit profile sign' before graduating",
        category,
      };
    }
    // Evidence-based nudge (E3): read the recorded observe window and point to the exact next step.
    const { parseObserveRecords, assessEnforceReadiness } =
      await import("./exec-broker/enforce-readiness.js");
    const r = assessEnforceReadiness(parseObserveRecords(await readAuditLog(cwd)));
    let detail: string;
    if (r.verdict === "ready") {
      detail = `runtime in OBSERVE — ${r.opsObserved} op(s) observed, none would be denied. Safe to graduate: run 'kit broker enforce'`;
    } else if (r.verdict === "would-block") {
      detail = `runtime in OBSERVE — ${r.wouldBlockOps} of ${r.opsObserved} observed op(s) would be denied under enforce; run 'kit broker enforce-readiness' to see them, then declare in [scope] + re-sign`;
    } else {
      detail =
        "runtime in OBSERVE — gates run but never deny, and no would-be denials are recorded yet. Exercise the workflow, then 'kit broker enforce-readiness' before graduating";
    }
    return { name, status: "warn", detail, category };
  }
  if (policy) {
    return {
      name,
      status: "pass",
      detail: "runtime mediation active — governed MCP ops are mediated against the signed scope",
      category,
    };
  }
  return {
    name,
    status: "fail",
    detail:
      "runtime mediation opted in but the scope is unsigned/invalid — governed MCP ops are fail-closed-denied; run 'kit profile sign'",
    category,
  };
}

/**
 * Deep skill-scanner delegate posture. The optional SkillSpector (NVIDIA) delegate deepens
 * `kit triage skill --deep` (static Stage 1 only — kit never runs its LLM stage). Optional, so its
 * absence is a `skip`, not a failure:
 *   pass  installed — deep static skill triage is available
 *   skip  not installed — --deep falls back to kit's built-in checks
 */
async function checkDeepSkillScanner(): Promise<DoctorCheck> {
  const name = "deep skill scanner";
  const category = "security";
  const { skillspectorStatus } = await import("./skillspector-delegate.js");
  const s = await skillspectorStatus();
  return s.available
    ? {
        name,
        status: "pass",
        detail: `SkillSpector ${s.version ? `${s.version} ` : ""}— deep skill triage available (static Stage 1 only; kit never runs its LLM stage)`,
        category,
      }
    : { name, status: "skip", detail: s.detail, category };
}

/**
 * Triage pre-commit gate posture (increment 2d). Reports whether the commit-time triage chokepoint
 * (`kit triage check-deps` + `kit triage check-skills`) is actually wired into the repo's pre-commit
 * hook — the honest counterpart to `kit setup --recommended` installing it. Never silent:
 *   pass  both triage gates present in the pre-commit hook
 *   warn  the hook exists but is missing one gate (partial — e.g. wired before check-skills shipped)
 *   skip  not a git repo, or the gates aren't wired (optional; run `kit setup --recommended`)
 * Pure decision split out for testing.
 */
export function triageGateStatus(hookContent: string | null): {
  status: DoctorCheckStatus;
  detail: string;
} {
  const has = (needle: string) => !!hookContent && hookContent.includes(needle);
  const deps = has("triage check-deps");
  const skills = has("triage check-skills");
  if (deps && skills) {
    return { status: "pass", detail: "pre-commit runs triage check-deps + check-skills" };
  }
  if (deps || skills) {
    return {
      status: "warn",
      detail: `pre-commit wires only triage ${deps ? "check-deps" : "check-skills"} — missing ${
        deps ? "check-skills" : "check-deps"
      }; re-run 'kit setup --recommended'`,
    };
  }
  return {
    status: "skip",
    detail:
      "triage pre-commit gates not wired — run 'kit setup --recommended' to enforce dep/skill triage at commit time",
  };
}

async function checkTriageGates(cwd: string): Promise<DoctorCheck> {
  const name = "triage pre-commit gates";
  const category = "security";
  const { isGitRepository } = await import("./check-hooks.js");
  if (!isGitRepository()) {
    return { name, status: "skip", detail: "not a git repository", category };
  }
  const { resolveHooksDir } = await import("./hooks.js");
  const hookPath = join(resolveHooksDir(join(cwd, ".git")), "pre-commit");
  let content: string | null;
  try {
    content = await readFile(hookPath, "utf-8");
  } catch {
    content = null; // no pre-commit hook → gates not wired
  }
  const { status, detail } = triageGateStatus(content);
  return { name, status, detail, category };
}

/**
 * Agent egress-exposure posture. The OpenAI×HuggingFace eval-escape incident (2026-07) turned on
 * exactly this gap: an agent had an install/exec capability but its egress was NOT scope-bound, so a
 * package/exec tool reached the open internet. kit warns when the install-gate is wired (the agent
 * CAN install/run tools) but the exec-broker egress gate (`gate-egress`) is NOT — the escape-hatch
 * class. Never silent:
 *   skip  no install/exec gate wired here — nothing with that capability to constrain
 *   pass  install/exec gate present AND egress is scope-bound (gate-egress wired)
 *   warn  install/exec gate present but egress is NOT scope-bound — the escape-hatch gap
 * Pure decision split out for testing.
 */
export function agentEgressExposureStatus(g: { installGate: boolean; egressGate: boolean }): {
  status: DoctorCheckStatus;
  detail: string;
} {
  if (!g.installGate) {
    return {
      status: "skip",
      detail:
        "no install/exec gate wired here — nothing with an install/exec capability to constrain",
    };
  }
  if (g.egressGate) {
    return {
      status: "pass",
      detail:
        "install/exec gate present and egress is scope-bound (gate-egress wired) — a spawned install/exec tool cannot reach off-scope hosts",
    };
  }
  return {
    status: "warn",
    detail:
      "agent can install/run tools (install-gate wired) but egress is NOT scope-bound — a package/exec tool could reach the open internet (the OpenAI eval-escape class). Wire it: 'kit agent-config --broker-gate' + declare [scope].egress",
  };
}

async function checkAgentEgressExposure(cwd: string): Promise<DoctorCheck> {
  const { gateLiveness } = await import("./agent-config.js");
  const live = gateLiveness(cwd);
  const { status, detail } = agentEgressExposureStatus(live);
  return { name: "agent egress exposure", status, detail, category: "security" };
}

/**
 * OS containment posture (the sandbox BELOW the tool boundary — defense-in-depth). kit
 * governs the tool boundary; a sandbox contains what happens beneath it. Advisory, never a
 * hard fail — the sandbox is a complementary layer the operator owns:
 *   pass  a container / seccomp isolation signal is present
 *   skip  containment can't be determined (non-Linux / restricted /proc) — NOT "not contained"
 *   skip  no OS containment, but nothing with an install/exec capability is wired here
 *   warn  install/exec gate wired AND no OS containment below it — pair kit with a sandbox
 * Pure decision split out for testing.
 */
export function containmentPostureStatus(
  v: ContainmentVerdict,
  installGateWired: boolean,
): { status: DoctorCheckStatus; detail: string } {
  if (v.mechanism === "unknown") {
    return {
      status: "skip",
      detail: "cannot determine OS containment (non-Linux / restricted /proc) — not a verdict",
    };
  }
  if (v.contained) {
    return {
      status: "pass",
      detail: `running inside ${v.mechanism} isolation (${v.confidence}) — ${v.details.join("; ")}`,
    };
  }
  if (!installGateWired) {
    return {
      status: "skip",
      detail: "no OS containment detected, and no install/exec capability wired here to contain",
    };
  }
  return {
    status: "warn",
    detail:
      "install/exec capability wired with NO OS containment below the tool boundary — kit governs the tool boundary, but pair it with a sandbox (container/seccomp) for the layer beneath (defense-in-depth)",
  };
}

async function checkContainment(cwd: string): Promise<DoctorCheck> {
  const { gatherContainmentSignals, detectContainment, containmentEnforcement } =
    await import("./containment.js");
  const { gateLiveness } = await import("./agent-config.js");
  const verdict = detectContainment(gatherContainmentSignals());

  // Is containment a hard requirement? [governance.containment] require = true flips this check
  // from advisory posture to a fail-closed gate.
  const required = await containmentRequired(cwd);
  if (required) {
    const { status, detail } = containmentEnforcement(verdict, true);
    await auditContainmentVerdict(cwd, verdict, true, status);
    return { name: "OS containment", status, detail, category: "security" };
  }

  const { status, detail } = containmentPostureStatus(verdict, gateLiveness(cwd).installGate);
  return { name: "OS containment", status, detail, category: "security" };
}

/** Read [governance.containment] require from .kit.toml. Best-effort false on any read error. */
async function containmentRequired(cwd: string): Promise<boolean> {
  try {
    const { loadConfig } = await import("./config.js");
    const { resolve } = await import("node:path");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml"));
    return cfg.governance?.containment?.require === true;
  } catch {
    return false;
  }
}

/**
 * Record the containment verdict to the sealed audit when it is policy-relevant (required).
 * Best-effort: a missing .kit.toml / audit backend must never abort the doctor check — the
 * verdict the operator sees is the source of truth, this is the durable evidence of it.
 */
async function auditContainmentVerdict(
  cwd: string,
  verdict: ContainmentVerdict,
  required: boolean,
  status: string,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { mergeGovernanceConfigAsync } = await import("./governance.js");
    const { logAuditEvent } = await import("./audit.js");
    const { resolve } = await import("node:path");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml"));
    const gov = await mergeGovernanceConfigAsync(cfg.governance);
    await logAuditEvent(gov, {
      operation: "doctor.containment",
      environment: gov.environment,
      success: status === "pass",
      metadata: {
        required,
        mechanism: verdict.mechanism,
        contained: verdict.contained,
        confidence: verdict.confidence,
        status,
      },
    });
  } catch {
    /* best-effort — the rendered verdict is the source of truth, not this log line */
  }
}

/**
 * Keyless-credential posture (Pillar 2 tail — "sign, don't store"). Reports whether any hosts are
 * declared keyless (`[scope].sign`) and whether kit can actually sign for them — never silent:
 *   skip  no keyless hosts declared
 *   pass  keyless hosts declared, scope VERIFIED, and a usable identity can sign
 *   fail  keyless hosts declared but the scope is unsigned/unverified (list not trusted), OR
 *         verified but no usable identity to sign with — requests would be fail-closed denied
 */
async function checkKeyless(cwd: string): Promise<DoctorCheck> {
  const name = "keyless credentials";
  const category = "security";
  const { signHostsDeclared, signHosts, detail } = await profileBrokerPolicy(cwd);
  if (signHostsDeclared.length === 0) {
    return {
      name,
      status: "skip",
      detail:
        "no keyless hosts declared — add hosts to [scope].sign and re-sign to require signed requests instead of stored tokens",
      category,
    };
  }
  if (signHosts.length === 0) {
    return {
      name,
      status: "fail",
      detail: `${signHostsDeclared.length} keyless host(s) declared but the scope is unverified — ${detail}; not trusted (fail-closed)`,
      category,
    };
  }
  const identity = tryLoadIdentity();
  if (!identity || isRevoked(identity.id)) {
    return {
      name,
      status: "fail",
      detail: `${signHosts.length} keyless host(s) require signing but ${identity ? `identity ${identity.id} is revoked` : "no usable identity is available"} — requests fail-closed`,
      category,
    };
  }
  return {
    name,
    status: "pass",
    detail: `${signHosts.length} keyless host(s) require signed requests; identity ${identity.id} ready (no stored bearer)`,
    category,
  };
}

/**
 * Control-plane posture (Pillar 2): is a DISTRIBUTED org policy present at this project, and is it
 * trustworthy? Honest — "distributed" must never silently mean "unverified":
 *   skip  no .kit-policy.toml here (nothing distributed yet)
 *   pass  policy present + signature verified (org standard + any RBAC it carries govern)
 *   warn  present but unsigned/unverifiable — run kit policy verify
 *   fail  present but signature invalid/revoked, or unparseable — not trusted
 */
function checkControlPlane(cwd: string): DoctorCheck {
  const name = "control plane (org policy)";
  const category = "security";
  if (!existsSync(getPolicyPath(cwd))) {
    return {
      name,
      status: "skip",
      detail: "no .kit-policy.toml here — `kit policy pull <source>` to fetch a signed org policy",
      category,
    };
  }
  const doc = loadPolicy(cwd);
  if (!doc) {
    return {
      name,
      status: "fail",
      detail: "org policy present but unparseable — not trusted",
      category,
    };
  }
  const v = verifyPolicy(cwd);
  const rbac = extractRbac(doc);
  const rbacNote = rbac
    ? ` · RBAC ${Object.keys(rbac.roles).length} role(s), ${rbac.bindings.length} binding(s)`
    : "";
  if (v.status === "valid") {
    return {
      name,
      status: "pass",
      detail: `org policy verified${v.fingerprint ? ` (${v.fingerprint})` : ""}${rbacNote}`,
      category,
    };
  }
  if (v.status === "unsigned" || v.status === "unverifiable") {
    return {
      name,
      status: "warn",
      detail: `org policy present but ${v.status} — ${v.detail}`,
      category,
    };
  }
  return {
    name,
    status: "fail",
    detail: `org policy ${v.status} — ${v.detail}; not trusted`,
    category,
  };
}

export async function runDoctor(config: kitConfig, cwd: string): Promise<DoctorResult> {
  const allChecks: DoctorCheck[] = [];

  allChecks.push(await checkNodeVersion(cwd));
  allChecks.push(await checkMise());

  const misePathCheck = await checkMisePath();
  if (misePathCheck) allChecks.push(misePathCheck);

  const envLocalCheck = await checkEnvLocal(config, cwd);
  if (envLocalCheck) allChecks.push(envLocalCheck);

  const toolsInPathChecks = await checkToolsInPath(config);
  allChecks.push(...toolsInPathChecks);

  const hookChecks = await checkGitHooks(config);
  allChecks.push(...hookChecks);

  const wrapperCheck = await checkKitWrapper();
  if (wrapperCheck) allChecks.push(wrapperCheck);

  const memoryHooksCheck = await checkMemoryHooks();
  if (memoryHooksCheck) allChecks.push(memoryHooksCheck);

  allChecks.push(checkIdentityKeystore());

  allChecks.push(await checkBrokerScope(cwd));
  allChecks.push(await checkBrokerRuntime(cwd));
  allChecks.push(await checkKeyless(cwd));
  allChecks.push(await checkAgentEgressExposure(cwd));
  allChecks.push(await checkContainment(cwd));
  allChecks.push(await checkDeepSkillScanner());
  allChecks.push(await checkTriageGates(cwd));
  allChecks.push(checkControlPlane(cwd));

  const passed = allChecks.filter((c) => c.status === "pass").length;
  const warnings = allChecks.filter((c) => c.status === "warn").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;

  return { checks: allChecks, passed, warnings, failed };
}
