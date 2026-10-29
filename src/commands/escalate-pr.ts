/** Pull request handoff from signed local evidence and current GitHub state. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { collectPrEscalations } from "../escalate-pr.js";
import { collectPrEvidence } from "../escalate-pr-io.js";
import { formatEscalationMessage } from "../escalate.js";
import { withGovernance } from "../governance-middleware.js";
import { isReadOnlyMode, refuseWrite } from "../read-only-mode.js";
import { hasFlag } from "../utils/flags.js";
import { redactSecrets } from "../utils/redactSecrets.js";

export async function cmdEscalatePr(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  return withGovernance(
    config,
    {
      operation: "escalate-pr",
      operationType: "write",
      metadata: {},
      scopeNeeds: { fsWrites: [".kit-escalation.txt"] },
    },
    async () => {
      if (isReadOnlyMode()) {
        const refusal = await refuseWrite("escalate-pr", {}, { cwd: process.cwd() });
        console.error(refusal.reason);
        return false;
      }
      try {
        const evidence = await collectPrEvidence(process.cwd(), {
          mergeDenied: hasFlag(process.argv, "--merge-denied"),
        });
        const items = collectPrEscalations(evidence);
        const message =
          items.length === 0
            ? "No pull request escalation actions found for this head. This does not approve a merge."
            : formatEscalationMessage(items, process.cwd());
        const path = resolve(process.cwd(), ".kit-escalation.txt");
        await writeFile(path, message + "\n", "utf8");
        console.log(message);
        console.log(`Written to ${path}`);
        return items.length === 0;
      } catch (error) {
        console.error(
          `Cannot inspect pull request: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
        return false;
      }
    },
  );
}
