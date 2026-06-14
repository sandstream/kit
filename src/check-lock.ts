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
 * Check lock files against config
 */
export async function checkLockFiles(config: kitConfig): Promise<LockCheckResult[]> {
  const results: LockCheckResult[] = [];

  // Check skills lock
  if (config.skills) {
    const skillsLock = await readSkillsLock();
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

      const authDetails = authRequired.length > 0
        ? ` (${authRequired.length} require auth: ${authRequired.map(s => skillsLock.skills[s].auth).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`
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
    const cliLock = await readCliLock();
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
      
      for (const toolName of configToolNames) {
        if (!cliLock.tools[toolName]) {
          missing.push(toolName);
        } else if (cliLock.tools[toolName].auth) {
          authRequired.push(toolName);
        }
      }

      const authDetails = authRequired.length > 0
        ? ` (${authRequired.length} require auth: ${authRequired.map(t => cliLock.tools[t].auth).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`
        : "";

      results.push({
        category: "cli-lock",
        exists: true,
        inSync: missing.length === 0,
        missing,
        authRequired,
        detail:
          missing.length === 0
            ? `all tools locked${authDetails}`
            : `${missing.length} tool(s) not in lock file${authDetails}`,
      });
    }
  }

  return results;
}
