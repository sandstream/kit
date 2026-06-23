import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface SkillLockEntry {
  version: string;
  resolved: string;
  required: boolean;
}

export interface SkillsLockFile {
  lockfileVersion: number;
  generatedAt: string;
  kit: string;
  skills: Record<string, SkillLockEntry>;
}

const LOCK_FILE = "skills-lock.json";

export async function readSkillsLock(dir: string): Promise<SkillsLockFile | null> {
  try {
    const content = await readFile(resolve(dir, LOCK_FILE), "utf-8");
    return JSON.parse(content) as SkillsLockFile;
  } catch {
    return null;
  }
}

export async function writeSkillsLock(dir: string, lock: SkillsLockFile): Promise<void> {
  const path = resolve(dir, LOCK_FILE);
  await writeFile(path, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}
