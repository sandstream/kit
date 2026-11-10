import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";

import {
  readRevocationStatus,
  type RevocationStatus,
  type RevocationObservation,
} from "./revocation-transport.js";
export type { RevocationStatus } from "./revocation-transport.js";

let lastRevocationCheck = 0;
let cachedRevocationStatus: RevocationStatus | null = null;
let cachedRevocationIdentity: string | undefined;

interface PendingCheck {
  active: number;
  latest?: PendingRequest;
}

interface PendingRequest {
  pending: boolean;
  result: Promise<RevocationObservation>;
}

const pendingChecks = new Map<string, PendingCheck>();

function revocationIdentity(config: Required<GovernanceConfig>, cwd?: string): string | undefined {
  try {
    return JSON.stringify([
      realpathSync(resolve(cwd ?? process.cwd())),
      config.revocation.revocation_endpoint,
      config.agent.id,
    ]);
  } catch {
    console.warn("Could not verify the project directory. Access denied.");
    return undefined;
  }
}

/** Return true when access is revoked or cannot be verified. */
export async function checkRevocationStatus(
  config: GovernanceConfig | undefined,
  opts: { cwd?: string } = {},
): Promise<boolean> {
  return !(await checkRevocationAccess(config, opts)).allowed;
}

/** Preserve the difference between confirmed revocation and an uncertain check. */
export async function checkRevocationAccess(
  config: GovernanceConfig | undefined,
  opts: { cwd?: string } = {},
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const result = await readCachedStatus(config, opts);
  if ("disabled" in result) return { allowed: true };
  if (!result.verified) {
    return { allowed: false, reason: "Revocation status could not be verified" };
  }
  return result.status.revoked ? { allowed: false, reason: "Access revoked" } : { allowed: true };
}

async function readCachedStatus(
  config: GovernanceConfig | undefined,
  opts: { cwd?: string },
): Promise<RevocationObservation | { disabled: true }> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.revocation.enabled) {
    return { disabled: true };
  }

  // Use cached status if recent enough
  const identity = revocationIdentity(fullConfig, opts.cwd);
  if (!identity) return { verified: false, error: "Could not verify the project directory." };
  const pending = pendingChecks.get(identity)?.latest;
  if (pending?.pending) return pending.result;
  const now = performance.now();
  const checkInterval = (fullConfig.revocation.check_interval ?? 300) * 1000;

  if (
    cachedRevocationStatus &&
    cachedRevocationIdentity === identity &&
    now - lastRevocationCheck < checkInterval
  ) {
    return { verified: true, status: cachedRevocationStatus };
  }

  return refreshRevocationStatus(fullConfig, identity);
}

/** Keep older in-flight replies from restoring permission after a newer check. */
function refreshRevocationStatus(
  config: Required<GovernanceConfig>,
  identity: string,
): Promise<RevocationObservation> {
  const state = pendingChecks.get(identity) ?? { active: 0 };
  pendingChecks.set(identity, state);
  state.active++;
  if (cachedRevocationIdentity === identity) cachedRevocationStatus = null;

  const request: PendingRequest = {
    pending: true,
    result: fetchRevocationStatus(config)
      .then((observation) => {
        request.pending = false;
        if (state.latest && state.latest !== request) return state.latest.result;
        if (observation.verified) {
          cachedRevocationIdentity = identity;
          cachedRevocationStatus = observation.status;
          lastRevocationCheck = performance.now();
        }
        return observation;
      })
      .finally(() => {
        if (--state.active === 0) pendingChecks.delete(identity);
      }),
  };
  state.latest = request;
  return request.result;
}

/**
 * Fetch revocation status from endpoint
 */
async function fetchRevocationStatus(
  config: Required<GovernanceConfig>,
): Promise<RevocationObservation> {
  const observation = await readRevocationStatus({
    endpoint: config.revocation.revocation_endpoint,
    agentId: config.agent.id,
  });
  if (!observation.verified) {
    console.warn(`${observation.error} Access denied until verification succeeds.`);
  }
  return observation;
}

/**
 * Force a fresh revocation check (ignore cache)
 */
export async function forceRevocationCheck(
  config: GovernanceConfig | undefined,
  opts: { cwd?: string } = {},
): Promise<RevocationStatus> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.revocation.enabled) {
    return { revoked: false };
  }

  const identity = revocationIdentity(fullConfig, opts.cwd);
  if (!identity) return { revoked: true };
  const result = await refreshRevocationStatus(fullConfig, identity);
  return result.verified ? { ...result.status } : { revoked: true };
}

/**
 * Legacy terminal handler: clear the local verdict and exit. Does not erase provider secrets.
 */
export async function handleRevocation(config: GovernanceConfig | undefined): Promise<void> {
  console.error("\n" + "=".repeat(80));
  console.error("ACCESS REVOKED");
  console.error("=".repeat(80));
  console.error("Your agent access has been revoked.");
  console.error("All operations are blocked.");
  console.error("Please contact the system administrator.");
  console.error("=".repeat(80) + "\n");

  // Clear local cache
  cachedRevocationStatus = null;
  lastRevocationCheck = 0;

  // Exit process
  process.exit(1);
}
