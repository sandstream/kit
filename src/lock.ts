/**
 * Lock file management for kit
 * Tracks exact versions of skills and CLI tools
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const KIT_DIR = ".kit";
const KIT_META_FILE = "kit.json";
const SKILLS_LOCK_FILE = "skills-lock.json";
const CLI_LOCK_FILE = "cli-lock.json";

export interface SkillsLock {
  version: number;
  kit?: string;
  skills: Record<string, SkillLockEntry>;
}

export interface SkillLockEntry {
  source: string;
  sourceType: "clawhub" | "github" | "github-private" | "local";
  computedHash: string;
  auth?: string;
  installedAt: string;
}

export interface CliLock {
  version: number;
  tools: Record<string, CliLockEntry>;
}

export interface CliLockEntry {
  version: string;
  source: "mise" | "npm" | "pip" | "manual";
  auth?: string;
  installedAt: string;
}

/**
 * kit metadata - identifies which kit this project uses
 */
export interface kitMeta {
  name: string; // e.g., "sandstream/standard"
  version: string; // e.g., "1.2.0"
}

/**
 * Get the .kit directory path
 */
function getkitDir(): string {
  return resolve(process.cwd(), KIT_DIR);
}

/**
 * Ensure .kit directory exists
 */
async function ensurekitDir(): Promise<void> {
  const dir = getkitDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Read skills lock file
 */
export async function readSkillsLock(): Promise<SkillsLock | null> {
  const lockPath = resolve(getkitDir(), SKILLS_LOCK_FILE);

  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = await readFile(lockPath, "utf-8");
    return JSON.parse(content) as SkillsLock;
  } catch (error) {
    console.error(`Failed to read ${SKILLS_LOCK_FILE}:`, error);
    return null;
  }
}

/**
 * Write skills lock file
 */
export async function writeSkillsLock(lock: SkillsLock): Promise<void> {
  await ensurekitDir();
  const lockPath = resolve(getkitDir(), SKILLS_LOCK_FILE);

  try {
    const content = JSON.stringify(lock, null, 2) + "\n";
    await writeFile(lockPath, content, "utf-8");
  } catch (error) {
    console.error(`Failed to write ${SKILLS_LOCK_FILE}:`, error);
    throw error;
  }
}

/**
 * Read CLI lock file
 */
export async function readCliLock(): Promise<CliLock | null> {
  const lockPath = resolve(getkitDir(), CLI_LOCK_FILE);

  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const content = await readFile(lockPath, "utf-8");
    return JSON.parse(content) as CliLock;
  } catch (error) {
    console.error(`Failed to read ${CLI_LOCK_FILE}:`, error);
    return null;
  }
}

/**
 * Write CLI lock file
 */
export async function writeCliLock(lock: CliLock): Promise<void> {
  await ensurekitDir();
  const lockPath = resolve(getkitDir(), CLI_LOCK_FILE);

  try {
    const content = JSON.stringify(lock, null, 2) + "\n";
    await writeFile(lockPath, content, "utf-8");
  } catch (error) {
    console.error(`Failed to write ${CLI_LOCK_FILE}:`, error);
    throw error;
  }
}

/**
 * Read kit metadata file
 */
export async function readkitMeta(): Promise<kitMeta | null> {
  const metaPath = resolve(getkitDir(), KIT_META_FILE);

  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content) as kitMeta;
  } catch (error) {
    console.error(`Failed to read ${KIT_META_FILE}:`, error);
    return null;
  }
}

/**
 * Write kit metadata file
 */
export async function writekitMeta(meta: kitMeta): Promise<void> {
  await ensurekitDir();
  const metaPath = resolve(getkitDir(), KIT_META_FILE);

  try {
    const content = JSON.stringify(meta, null, 2) + "\n";
    await writeFile(metaPath, content, "utf-8");
  } catch (error) {
    console.error(`Failed to write ${KIT_META_FILE}:`, error);
    throw error;
  }
}

/**
 * Pin identifier for a skill: sha256 of "source@version" (first 16 hex chars).
 * This identifies WHICH skill + version the lockfile pinned — it is NOT a
 * content-integrity hash and does not detect tampering of fetched skill content.
 * Content verification is tracked separately; kit's public docs do not claim
 * content verification, so this stays honest.
 */
function computeSkillHash(source: string, version: string): string {
  const content = `${source}@${version}`;
  return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * Parse version string to extract source and determine sourceType
 * Handles formats like:
 * - "^2.0" or "1.2.3" → clawhub (default registry)
 * - "github:owner/repo@tag" → github
 * - "get-convex/agent-skills" → github
 * - "./local/path" → local
 */
function parseSkillVersion(
  skillName: string,
  version: string,
): {
  source: string;
  sourceType: SkillLockEntry["sourceType"];
  auth?: string;
} {
  // Local path
  if (version.startsWith("./") || version.startsWith("../") || version.startsWith("/")) {
    return {
      source: version,
      sourceType: "local",
    };
  }

  // GitHub explicit format: github:owner/repo or github:owner/repo@tag
  if (version.startsWith("github:")) {
    const source = version.substring(7); // Remove "github:" prefix
    return {
      source,
      sourceType: "github",
      auth: "github",
    };
  }

  // GitHub org/repo format (e.g., "get-convex/agent-skills")
  if (version.includes("/") && !version.startsWith("http")) {
    return {
      source: version,
      sourceType: "github",
      auth: "github",
    };
  }

  // Default to clawhub for semver versions
  return {
    source: `${skillName}@${version}`,
    sourceType: "clawhub",
  };
}

/**
 * Update skills lock with installed skills
 * Accepts version strings and converts to hash-based format
 */
export async function updateSkillsLock(
  skills: Record<string, string>,
  kit?: string,
): Promise<void> {
  const existing = await readSkillsLock();

  const lock: SkillsLock = {
    version: 1,
    kit: kit || existing?.kit,
    skills: {},
  };

  // Preserve existing entries and merge with new ones
  if (existing) {
    lock.skills = { ...existing.skills };
  }

  // Add/update skills
  for (const [name, version] of Object.entries(skills)) {
    const parsed = parseSkillVersion(name, version);
    const existingEntry = lock.skills[name];

    lock.skills[name] = {
      source: parsed.source,
      sourceType: parsed.sourceType,
      computedHash: existingEntry?.computedHash || computeSkillHash(parsed.source, version),
      auth: parsed.auth || existingEntry?.auth,
      installedAt: existingEntry?.installedAt || new Date().toISOString(),
    };
  }

  await writeSkillsLock(lock);
}

/**
 * Update CLI lock with installed tools
 */
export async function updateCliLock(
  tools: Record<string, { version: string; source: CliLockEntry["source"]; auth?: string }>,
): Promise<void> {
  const existing = await readCliLock();

  const lock: CliLock = {
    version: 1,
    tools: {},
  };

  // Preserve existing entries and merge with new ones
  if (existing) {
    lock.tools = { ...existing.tools };
  }

  // Add/update tools
  for (const [name, info] of Object.entries(tools)) {
    lock.tools[name] = {
      version: info.version,
      source: info.source,
      auth: info.auth,
      installedAt: new Date().toISOString(),
    };
  }

  await writeCliLock(lock);
}

/**
 * Check if lock files are in sync with config
 */
export interface LockStatus {
  skillsLockExists: boolean;
  cliLockExists: boolean;
  skillsInSync: boolean;
  cliInSync: boolean;
  missingSkills: string[];
  missingTools: string[];
}

export async function checkLockStatus(
  configSkills: Record<string, string>,
  configTools: Record<string, string>,
): Promise<LockStatus> {
  const skillsLock = await readSkillsLock();
  const cliLock = await readCliLock();

  const status: LockStatus = {
    skillsLockExists: skillsLock !== null,
    cliLockExists: cliLock !== null,
    skillsInSync: true,
    cliInSync: true,
    missingSkills: [],
    missingTools: [],
  };

  // Check skills
  if (!skillsLock) {
    status.skillsInSync = false;
    status.missingSkills = Object.keys(configSkills);
  } else {
    for (const skillName of Object.keys(configSkills)) {
      if (!skillsLock.skills[skillName]) {
        status.skillsInSync = false;
        status.missingSkills.push(skillName);
      }
    }
  }

  // Check tools
  if (!cliLock) {
    status.cliInSync = false;
    status.missingTools = Object.keys(configTools);
  } else {
    for (const toolName of Object.keys(configTools)) {
      if (!cliLock.tools[toolName]) {
        status.cliInSync = false;
        status.missingTools.push(toolName);
      }
    }
  }

  return status;
}
