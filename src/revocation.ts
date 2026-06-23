import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";

export interface RevocationStatus {
  revoked: boolean;
  reason?: string;
  timestamp?: string;
}

let lastRevocationCheck = 0;
let cachedRevocationStatus: RevocationStatus | null = null;

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
  const status = await fetchRevocationStatus(fullConfig);

  cachedRevocationStatus = status;
  lastRevocationCheck = now;

  return status.revoked;
}

/**
 * Fetch revocation status from endpoint
 */
async function fetchRevocationStatus(
  config: Required<GovernanceConfig>,
): Promise<RevocationStatus> {
  if (!config.revocation.revocation_endpoint || !config.agent.id) {
    return { revoked: false };
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
      // If endpoint is unreachable, assume not revoked
      console.warn(`Revocation check failed: ${response.statusText}`);
      return { revoked: false };
    }

    const data = (await response.json()) as RevocationStatus;
    return data;
  } catch (error) {
    // If endpoint is unreachable, assume not revoked
    console.warn(`Revocation check failed: ${error}`);
    return { revoked: false };
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

  const status = await fetchRevocationStatus(fullConfig);

  cachedRevocationStatus = status;
  lastRevocationCheck = Date.now();

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
