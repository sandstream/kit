import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { SkillsConfig } from "./config.js";

export interface SkillCheckResult {
  name: string;
  versionSpec: string;
  required: boolean;
  installed: boolean;
}

const SKILLS_BASE = join(
  homedir(),
  ".npm-global",
  "lib",
  "node_modules",
  "openclaw",
  "skills",
);

async function isSkillInstalled(name: string): Promise<boolean> {
  try {
    await access(resolve(SKILLS_BASE, name, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

export async function checkSkills(
  config: SkillsConfig,
): Promise<SkillCheckResult[]> {
  const results: SkillCheckResult[] = [];

  for (const [name, versionSpec] of Object.entries(config.required ?? {})) {
    const installed = await isSkillInstalled(name);
    results.push({ name, versionSpec, required: true, installed });
  }

  for (const [name, versionSpec] of Object.entries(config.optional ?? {})) {
    const installed = await isSkillInstalled(name);
    results.push({ name, versionSpec, required: false, installed });
  }

  return results;
}
