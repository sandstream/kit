import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logAuditEvent, verifyAuditChain, type AuditEvent } from "../audit.js";
import {
  readAnchorRecord,
  tryReadProtectedAuditAnchorKey,
  verifyAgainstAnchor,
} from "../audit-anchor.js";
import { canonicalAuditLogPath } from "../audit-log-path.js";
import { loadConfig } from "../config.js";
import { mergeGovernanceConfigAsync } from "../governance.js";
import type { EnforceReadiness } from "../exec-broker/enforce-readiness.js";
import { BROKER_AUDIT_FILE } from "../exec-broker/observe-evidence.js";

type EnforceAuditPhase = "enforce-requested" | "enforce-enabled" | "enforce-failed";
export type EnforceAuditStatus = "disabled" | "recorded" | "incomplete";
type Governance = Awaited<ReturnType<typeof mergeGovernanceConfigAsync>>;

interface Transition {
  transitionId: string;
  fingerprint: string;
  profileDigest: string;
  opsObserved: number;
  forced: boolean;
}

type EnforceAuditStart =
  | { ok: false; reason: string }
  | {
      ok: true;
      recordOutcome: (phase: "enforce-enabled" | "enforce-failed") => Promise<EnforceAuditStatus>;
    };

async function loadAuditGovernance(cwd: string): Promise<Governance> {
  const config = await loadConfig(resolve(cwd, ".kit.toml")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return mergeGovernanceConfigAsync(config?.governance, cwd);
}

function auditLogPath(cwd: string, governance: Governance): string {
  return canonicalAuditLogPath(resolve(cwd, governance.audit.log_file || BROKER_AUDIT_FILE));
}

async function recordTransition(
  cwd: string,
  governance: Governance,
  transition: Transition,
  phase: EnforceAuditPhase,
  recovered = false,
): Promise<EnforceAuditStatus> {
  if (!governance.audit.enabled) return "disabled";
  const recorded = await logAuditEvent(
    governance,
    {
      operation: "broker.enforce",
      environment: governance.environment,
      success: phase !== "enforce-failed",
      metadata: { ...transition, phase, recovered: recovered || undefined },
    },
    { cwd },
  );
  return recorded ? "recorded" : "incomplete";
}

/** Record the request before any profile write. Use one audit destination for the transition. */
export async function startBrokerEnforceAudit(
  cwd: string,
  readiness: EnforceReadiness,
  forced: boolean,
  profile: Pick<Transition, "transitionId" | "fingerprint" | "profileDigest">,
): Promise<EnforceAuditStart> {
  let governance;
  try {
    governance = await loadAuditGovernance(cwd);
  } catch {
    return { ok: false, reason: "Cannot load the audit configuration in .kit.toml." };
  }
  if (governance.audit.enabled && readiness.verdict === "unverifiable") {
    try {
      if (
        auditLogPath(cwd, governance) === canonicalAuditLogPath(resolve(cwd, BROKER_AUDIT_FILE))
      ) {
        return {
          ok: false,
          reason:
            "The configured audit log holds unverifiable observe evidence. Preserve it and check the audit configuration.",
        };
      }
    } catch {
      return {
        ok: false,
        reason: "Cannot verify the audit destination for the enforcement request.",
      };
    }
  }
  const transition = {
    ...profile,
    opsObserved: readiness.opsObserved,
    forced,
  };
  const started = await recordTransition(cwd, governance, transition, "enforce-requested");
  if (started === "incomplete") {
    return { ok: false, reason: "Cannot record the enforcement request in the audit log." };
  }
  return {
    ok: true,
    recordOutcome: (phase) => recordTransition(cwd, governance, transition, phase),
  };
}

function matchingTransition(line: string, transitionId: string, profileDigest: string) {
  const { operation, metadata, success } = JSON.parse(line) as Partial<AuditEvent>;
  if (
    operation !== "broker.enforce" ||
    metadata?.profileDigest !== profileDigest ||
    metadata.transitionId !== transitionId ||
    typeof metadata.fingerprint !== "string" ||
    typeof metadata.opsObserved !== "number" ||
    typeof metadata.forced !== "boolean"
  ) {
    return undefined;
  }
  return {
    phase: metadata.phase,
    success,
    transition: {
      transitionId,
      fingerprint: metadata.fingerprint,
      profileDigest,
      forced: metadata.forced,
      opsObserved: metadata.opsObserved,
    },
  };
}

function readTransition(content: string, transitionId: string, profileDigest: string) {
  let pending: Transition | undefined;
  let completed = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const event = matchingTransition(line, transitionId, profileDigest);
    if (!event) continue;
    if (event.phase === "enforce-requested" && event.success === true) {
      pending = event.transition;
    } else if (pending && event.phase === "enforce-enabled" && event.success === true) {
      completed = true;
      pending = undefined;
    } else if (event.phase === "enforce-failed" && event.success === false) {
      pending = undefined;
    }
  }
  return { completed, pending };
}

/** Recover a recorded request against the verified installed profile and local audit seal. */
export async function reconcileBrokerEnforceAudit(
  cwd: string,
  transitionId: string | undefined,
  profileDigest: string,
): Promise<EnforceAuditStatus> {
  try {
    const governance = await loadAuditGovernance(cwd);
    if (!governance.audit.enabled) return "disabled";
    if (!transitionId) return "incomplete";
    const path = auditLogPath(cwd, governance);
    const content = await readFile(path, "utf8");
    if (!verifyAuditChain(content).ok) return "incomplete";
    const anchor = await readAnchorRecord(path);
    const key = anchor ? await tryReadProtectedAuditAnchorKey() : null;
    const seal = verifyAgainstAnchor(content, anchor, key);
    if (seal.status !== "anchored-ok" || seal.newSinceAnchor !== 0) return "incomplete";

    const { completed, pending } = readTransition(content, transitionId, profileDigest);
    if (pending) {
      return await recordTransition(cwd, governance, pending, "enforce-enabled", true);
    }
    return completed ? "recorded" : "incomplete";
  } catch {
    return "incomplete";
  }
}
