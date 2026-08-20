/**
 * Check lock file status
 */

import { readSkillsLock, readCliLock } from "./lock.js";
import type { kitConfig } from "./config.js";

export interface LockCheckResult {
  category: "skills-lock" | "cli-lock";
  exists: boolean;
  inSync: boolean;
  missing: string[];
  detail: string;
  authRequired?: string[]; // Tools/skills that require authentication
}

/**
 * Check lock files against config.
 *
 * `cwd` matters: without it the readers resolved `.kit/` from `process.cwd()`, so the MCP
 * `kit_context` tool reported the SERVER process's lock state inside an otherwise correctly-scoped
 * description of a different project — one honest object with one dishonest field in it.
 */
export async function checkLockFiles(config: kitConfig, cwd?: string): Promise<LockCheckResult[]> {
  const results: LockCheckResult[] = [];

  // Check skills lock
  if (config.skills) {
    const skillsLock = await readSkillsLock(cwd);
    const configSkills = {
      ...config.skills.required,
      ...config.skills.optional,
    };
    const configSkillNames = Object.keys(configSkills);

    if (!skillsLock) {
      results.push({
        category: "skills-lock",
        exists: false,
        inSync: false,
        missing: configSkillNames,
        detail: "skills-lock.json not found",
      });
    } else {
      const missing: string[] = [];
      const authRequired: string[] = [];

      for (const skillName of configSkillNames) {
        if (!skillsLock.skills[skillName]) {
          missing.push(skillName);
        } else if (skillsLock.skills[skillName].auth) {
          authRequired.push(skillName);
        }
      }

      const authDetails =
        authRequired.length > 0
          ? ` (${authRequired.length} require auth: ${authRequired
              .map((s) => skillsLock.skills[s].auth)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(", ")})`
          : "";

      results.push({
        category: "skills-lock",
        exists: true,
        inSync: missing.length === 0,
        missing,
        authRequired,
        detail:
          missing.length === 0
            ? `all skills locked${authDetails}`
            : `${missing.length} skill(s) not in lock file${authDetails}`,
      });
    }
  }

  // Check CLI lock
  if (config.tools) {
    const cliLock = await readCliLock(cwd);
    const configToolNames = Object.keys(config.tools);

    if (!cliLock) {
      results.push({
        category: "cli-lock",
        exists: false,
        inSync: false,
        missing: configToolNames,
        detail: "cli-lock.json not found",
      });
    } else {
      const missing: string[] = [];
      const authRequired: string[] = [];
      // Provenance drift: the lock claims an installer, the PATH winner comes from another one.
      // The old check compared names only, so a lock saying `mise` for /opt/homebrew/bin/vercel
      // reported `in sync` (#500). A lock whose purpose is provenance has to be checked on it.
      const drifted: string[] = [];
      const { describeTool } = await import("./tool-inventory.js");
      const { provenanceMismatch } = await import("./tool-provenance.js");

      for (const toolName of configToolNames) {
        const entry = cliLock.tools[toolName];
        if (!entry) {
          missing.push(toolName);
          continue;
        }
        if (entry.auth) authRequired.push(toolName);
        const facts = await describeTool(toolName);
        if (!facts.provenance) continue; // not installed here — nothing measured to contradict
        const recorded = entry.sourceDetail ?? entry.source;
        const verdict = provenanceMismatch(recorded, facts.provenance);
        if (verdict.mismatch) drifted.push(`${toolName}: ${verdict.reason}`);
      }

      const authDetails =
        authRequired.length > 0
          ? ` (${authRequired.length} require auth: ${authRequired
              .map((t) => cliLock.tools[t].auth)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(", ")})`
          : "";

      const driftDetail =
        drifted.length > 0
          ? ` — provenance drift: ${drifted.join("; ")} (re-run \`kit fix\` to re-record)`
          : "";
      results.push({
        category: "cli-lock",
        exists: true,
        // Drift counts against sync: the lock is a provenance record, and a record that names
        // the wrong installer is not in sync with the machine it describes.
        inSync: missing.length === 0 && drifted.length === 0,
        missing,
        authRequired,
        detail:
          missing.length === 0 && drifted.length === 0
            ? `all tools locked${authDetails}`
            : missing.length > 0
              ? `${missing.length} tool(s) not in lock file${authDetails}${driftDetail}`
              : `${drifted.length} tool(s) with wrong recorded provenance${authDetails}${driftDetail}`,
      });
    }
  }

  return results;
}
