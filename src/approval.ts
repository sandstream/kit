import * as readline from "node:readline/promises";
import { isNonInteractive } from "./environment.js";
import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig, isDestructiveOperation } from "./governance.js";
import { IdGenerators } from "./id-generator.js";

export interface ApprovalRequest {
  operation: string;
  environment: string;
  reason: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalResponse {
  approved: boolean;
  approval_id?: string;
  denied_reason?: string;
  timeout?: boolean;
}

/**
 * Send approval request to webhook
 */
async function sendApprovalWebhook(request: ApprovalRequest, webhookUrl: string): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: request.operation,
        environment: request.environment,
        agent_id: request.agent_id,
        reason: request.reason,
        details: request.metadata,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      console.error(`Failed to send approval webhook: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error("Failed to send approval webhook:", error);
  }
}

/**
 * Wait for approval via Remote API
 */
async function waitForRemoteApproval(
  approvalId: string,
  companyId: string,
  timeoutMs: number,
): Promise<ApprovalResponse> {
  const apiUrl = process.env.KIT_REMOTE_URL || "http://localhost:3199";
  const url = `${apiUrl}/api/companies/${companyId}/approvals/${approvalId}`;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.status === "approved") {
          return { approved: true, approval_id: approvalId };
        }
        if (data.status === "denied") {
          return {
            approved: false,
            approval_id: approvalId,
            denied_reason: data.reason,
          };
        }
      }
    } catch (error) {
      console.error("Error checking approval status:", error);
    }

    // Wait 2 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return { approved: false, timeout: true };
}

/**
 * Request human approval for an operation
 */
export async function requestApproval(
  config: GovernanceConfig | undefined,
  request: ApprovalRequest,
  companyId?: string,
): Promise<boolean> {
  const fullConfig = mergeGovernanceConfig(config);

  // If approval is not configured, auto-approve
  if (!fullConfig.approval) {
    return true;
  }

  // Check if operation requires approval
  const requiresApproval =
    isDestructiveOperation(fullConfig, request.operation) ||
    (request.environment === "prod" && fullConfig.approval.production_writes);

  if (!requiresApproval) {
    return true;
  }

  // Display approval request
  console.log("\n" + "=".repeat(80));
  console.log("APPROVAL REQUIRED");
  console.log("=".repeat(80));
  console.log(`Operation: ${request.operation}`);
  console.log(`Environment: ${request.environment}`);
  console.log(`Reason: ${request.reason}`);

  if (request.metadata && Object.keys(request.metadata).length > 0) {
    console.log(`Metadata: ${JSON.stringify(request.metadata, null, 2)}`);
  }

  console.log("=".repeat(80));

  // Send webhook notification if configured
  const webhookUrl = process.env.KIT_APPROVAL_WEBHOOK;
  if (webhookUrl) {
    await sendApprovalWebhook(request, webhookUrl);
  }

  // If company ID is provided, use Remote API approval flow
  if (companyId) {
    const approvalId = IdGenerators.approval();
    const timeout = fullConfig.approval.approval_timeout || 3600;

    console.log(`\nWaiting for approval via Remote API (timeout: ${timeout}s)...`);
    console.log(`Approval ID: ${approvalId}`);

    const result = await waitForRemoteApproval(approvalId, companyId, timeout * 1000);

    if (result.approved) {
      console.log("✓ Operation approved");
      return true;
    }
    if (result.timeout) {
      console.log("✗ Approval timeout");
      return false;
    }
    if (result.denied_reason) {
      console.log(`✗ Operation denied: ${result.denied_reason}`);
      return false;
    }
    return false;
  }

  // Non-interactive mode: skip CLI prompt and deny
  if (isNonInteractive()) {
    console.error("✗ Approval required but running in non-interactive mode — operation denied");
    return false;
  }

  // Fall back to CLI approval
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("\nDo you approve this operation? (yes/no): ");
    rl.close();

    return answer.toLowerCase().trim() === "yes";
  } catch (error) {
    rl.close();
    console.error("Failed to request approval:", error);
    return false;
  }
}

/**
 * Check if an operation would require approval without actually requesting it
 */
export function wouldRequireApproval(
  config: GovernanceConfig | undefined,
  operation: string,
  environment: string,
): boolean {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.approval) {
    return false;
  }

  return (
    isDestructiveOperation(fullConfig, operation) ||
    (environment === "prod" && fullConfig.approval.production_writes === true)
  );
}
