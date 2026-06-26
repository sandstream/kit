import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";

export interface RevocationStatus {
  revoked: boolean;
  reason?: string;
  timestamp?: string;
}

let lastRevocationCheck = 0;
let cachedRevocationStatus: RevocationStatus | null = null;

// Internal fetch result. `cacheable` is false for fail-closed results derived
// from ambiguous/erroring responses — those must NOT be cached as a verdict,
// otherwise a single bad response would pin the agent into a state until the
// cache TTL expires (and an ambiguous "revoked" would survive a recovery).
interface FetchResult {
  status: RevocationStatus;
  cacheable: boolean;
}

/**
 * Check if agent access has been revoked
 */
export async function checkRevocationStatus(
  config: GovernanceConfig | undefined,
): Promise<boolean> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.revocation.enabled) {
    return false;
  }

  // Use cached status if recent enough
  const now = Date.now();
  const checkInterval = (fullConfig.revocation.check_interval || 300) * 1000;

  if (cachedRevocationStatus && now - lastRevocationCheck < checkInterval) {
    return cachedRevocationStatus.revoked;
  }

  // Check revocation endpoint
  const { status, cacheable } = await fetchRevocationStatus(fullConfig);

  if (cacheable) {
    cachedRevocationStatus = status;
    lastRevocationCheck = now;
  }

  return status.revoked;
}

/**
 * Fetch revocation status from endpoint
 */
async function fetchRevocationStatus(config: Required<GovernanceConfig>): Promise<FetchResult> {
  if (!config.revocation.revocation_endpoint || !config.agent.id) {
    // Revocation is enabled (callers gate on revocation.enabled) but the
    // endpoint or agent id is missing — we cannot prove access is still valid.
    // Fail CLOSED. Don't cache: this is a misconfiguration, not a verdict.
    console.warn(
      "Revocation enabled but revocation_endpoint/agent.id is missing — failing closed (assume revoked)",
    );
    return { status: { revoked: true }, cacheable: false };
  }

  try {
    const endpoint = config.revocation.revocation_endpoint.replace("{agent_id}", config.agent.id);

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      // Fail CLOSED: a revocation endpoint that is configured but errors must NOT
      // be read as "not revoked" — that lets a possibly-revoked agent keep running
      // and lets anyone who can disrupt the endpoint disable the kill-switch.
      console.warn(
        `Revocation check failed (${response.statusText}) — failing closed (assume revoked)`,
      );
      return { status: { revoked: true }, cacheable: false };
    }

    const data = (await response.json()) as unknown;

    // Validate shape: a 200 with no boolean `revoked` ({}, {revoked:"no"}, …) is
    // ambiguous. Treating it as not-revoked is fail-OPEN and would be cached as a
    // verdict. Fail CLOSED and don't cache the ambiguous result.
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as Record<string, unknown>).revoked !== "boolean"
    ) {
      console.warn(
        "Revocation response missing boolean `revoked` field — failing closed (assume revoked)",
      );
      return { status: { revoked: true }, cacheable: false };
    }

    return { status: data as RevocationStatus, cacheable: true };
  } catch (error) {
    // Network/parse failure — fail CLOSED (see above).
    console.warn(`Revocation check failed (${error}) — failing closed (assume revoked)`);
    return { status: { revoked: true }, cacheable: false };
  }
}

/**
 * Force a fresh revocation check (ignore cache)
 */
export async function forceRevocationCheck(
  config: GovernanceConfig | undefined,
): Promise<RevocationStatus> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.revocation.enabled) {
    return { revoked: false };
  }

  const { status, cacheable } = await fetchRevocationStatus(fullConfig);

  if (cacheable) {
    cachedRevocationStatus = status;
    lastRevocationCheck = Date.now();
  }

  return status;
}

/**
 * Clear local secrets and caches (called when revocation detected)
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

/**
 * Get formatted revocation status for display
 */
export function formatRevocationStatus(status: RevocationStatus): string {
  if (!status.revoked) {
    return "✓ Access active";
  }

  let message = "✗ Access revoked";

  if (status.reason) {
    message += ` - ${status.reason}`;
  }

  if (status.timestamp) {
    message += ` (${new Date(status.timestamp).toLocaleString()})`;
  }

  return message;
}
