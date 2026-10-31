/** List missing local tools, services, secrets, or pull request actions. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveConfigPath } from "../cli-shared.js";
import { checkSecrets } from "../check-secrets.js";
import { checkServices } from "../check-services.js";
import { checkTools } from "../check-tools.js";
import { loadConfig } from "../config.js";
import { collectEscalations, formatEscalationMessage } from "../escalate.js";
import { withGovernance } from "../governance-middleware.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { cmdEscalatePr } from "./escalate-pr.js";

export async function cmdEscalate(): Promise<boolean> {
  if (process.argv[3] === "pr") {
    if (process.argv[4] && !process.argv[4].startsWith("--")) {
      console.error("Use: kit escalate pr [--merge-denied]");
      return false;
    }
    return cmdEscalatePr();
  }
  if (hasFlag(process.argv, "--merge-denied")) {
    console.error("--merge-denied requires kit escalate pr");
    return false;
  }
  const config = await loadConfig(resolveConfigPath());

  return withGovernance(
    config,
    {
      operation: "escalate",
      operationType: "read",
      metadata: {},
      scopeNeeds: { fsWrites: [".kit-escalation.txt"] },
    },
    async () => {
      const toolResults = config.tools ? await checkTools(config.tools) : [];
      const serviceResults = config.services ? await checkServices(config.services) : [];
      const secretResults = config.secrets
        ? await checkSecrets(config.secrets)
        : { templateExists: null, keys: [] };
      const items = collectEscalations(toolResults, serviceResults, secretResults.keys);

      if (items.length === 0) {
        console.log(`${c.green}All checks passed. Nothing to escalate.${c.reset}`);
        return true;
      }

      const message = formatEscalationMessage(items, process.cwd());
      console.log(`${c.bold}${c.yellow}Escalation summary${c.reset}\n`);
      console.log(message);
      const escalationPath = resolve(process.cwd(), ".kit-escalation.txt");
      await writeFile(escalationPath, message, "utf8");
      console.log(`${c.dim}Written to ${escalationPath}${c.reset}`);
      console.log(`${c.dim}Send this to the project owner for manual resolution.${c.reset}\n`);
      return false;
    },
  );
}
