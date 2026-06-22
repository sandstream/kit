/**
 * Disk-encryption check — verify the host's full-disk encryption is enabled.
 *
 * Why: kit's secret-dense local state (`~/.kit/memory.db`, materialized
 * `.env.local`) is plaintext at rest, protected only by 0600 perms. The correct
 * at-rest control for a whole secret-dense store is OS full-disk encryption
 * (FileVault / LUKS / BitLocker). This verifies it is ON and warns loudly if not —
 * a stolen laptop with FDE off exposes every cached secret.
 *
 * Also flags the `KIT_MEMORY_DIR` foot-gun: if the memory store is redirected
 * INTO a git working tree, the secret-dense DB could be committed and pushed.
 *
 * Deterministic, zero-LLM, FAIL-OPEN: when we cannot determine the status
 * (unknown OS, command missing, CI/container), we SKIP rather than cry wolf.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { getMemoryDir } from "./memory/db.js";
import { getCurrentProjectRoot } from "./memory/project.js";

const exec = promisify(execFile);

// ─── Pure interpreters (unit-tested) ────────────────────────────────────────

/** macOS `fdesetup status`: true = on, false = off, null = indeterminate. */
export function interpretFileVault(out: string): boolean | null {
  const s = out.toLowerCase();
  if (s.includes("filevault is on")) return true;
  if (s.includes("filevault is off")) return false;
  return null;
}

/** Windows `manage-bde -status`: true = protected, false = off, null = unknown. */
export function interpretBitLocker(out: string): boolean | null {
  const s = out.toLowerCase();
  if (s.includes("protection on")) return true;
  if (s.includes("protection off") || s.includes("fully decrypted")) return false;
  return null;
}

/** Linux `lsblk -o TYPE`: a `crypt` device ⇒ encrypted volume present (true),
 *  otherwise indeterminate (null) — absence is NOT proof of "off". */
export function interpretLsblk(out: string): boolean | null {
  return /(^|\s)crypt(\s|$)/m.test(out) ? true : null;
}

/** Is the memory dir inside the repo working tree (committable foot-gun)? */
export function memoryDirInsideRepo(memDir: string, repoRoot: string): boolean {
  const m = resolve(memDir);
  const r = resolve(repoRoot);
  return m === r || m.startsWith(r + "/");
}

// ─── Checks ─────────────────────────────────────────────────────────────────

const SKIP: Omit<SecurityCheckResult, "detail"> & { detail: string } = {
  category: "exposure",
  name: "disk encryption",
  status: "skip",
  detail: "could not determine full-disk-encryption status",
};

/**
 * Verify full-disk encryption. Fail-open: any uncertainty → skip.
 */
export async function checkDiskEncryption(): Promise<SecurityCheckResult> {
  // Don't cry wolf in CI / containers — those aren't the at-rest threat model.
  if (process.env.CI) {
    return { ...SKIP, detail: "skipped in CI (not the at-rest threat model)" };
  }

  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("fdesetup", ["status"], { timeout: 5_000 });
      const on = interpretFileVault(stdout);
      if (on === true) {
        return { category: "exposure", name: "disk encryption", status: "pass", detail: "FileVault is enabled" };
      }
      if (on === false) {
        return {
          category: "exposure",
          name: "disk encryption",
          status: "warn",
          severity: "high",
          detail: "FileVault is OFF — kit's local secret-dense store (~/.kit/memory.db) is unencrypted at rest",
          suggestion: "Enable FileVault: System Settings → Privacy & Security → FileVault",
        };
      }
      return SKIP;
    }

    if (process.platform === "win32") {
      const { stdout } = await exec("manage-bde", ["-status", "C:"], { timeout: 8_000 });
      const on = interpretBitLocker(stdout);
      if (on === true) {
        return { category: "exposure", name: "disk encryption", status: "pass", detail: "BitLocker protection is on" };
      }
      if (on === false) {
        return {
          category: "exposure",
          name: "disk encryption",
          status: "warn",
          severity: "high",
          detail: "BitLocker is OFF — kit's local secret-dense store is unencrypted at rest",
          suggestion: "Enable BitLocker: Settings → Privacy & security → Device encryption",
        };
      }
      return SKIP;
    }

    if (process.platform === "linux") {
      const { stdout } = await exec("lsblk", ["-o", "TYPE"], { timeout: 5_000 });
      if (interpretLsblk(stdout) === true) {
        return { category: "exposure", name: "disk encryption", status: "pass", detail: "LUKS-encrypted volume detected" };
      }
      // No crypt device found — can't confirm. Warn at low severity (honest "verify").
      return {
        category: "exposure",
        name: "disk encryption",
        status: "warn",
        severity: "low",
        detail: "could not confirm full-disk encryption (no LUKS device found) — verify your disk is encrypted",
        suggestion: "Confirm with: lsblk (look for type 'crypt'), or your distro's disk-encryption settings",
      };
    }

    return SKIP;
  } catch {
    return SKIP; // command missing / not permitted → fail-open
  }
}

/**
 * Flag the KIT_MEMORY_DIR foot-gun: secret-dense store redirected into a repo.
 * Sync, fail-open.
 */
export function checkMemoryDirSafety(): SecurityCheckResult {
  try {
    const memDir = getMemoryDir();
    const repoRoot = getCurrentProjectRoot();
    if (memoryDirInsideRepo(memDir, repoRoot)) {
      return {
        category: "exposure",
        name: "memory store location",
        status: "warn",
        severity: "high",
        detail: `kit memory store (${memDir}) is inside the repo working tree — the secret-dense DB could be committed`,
        suggestion: "Unset KIT_MEMORY_DIR (defaults to ~/.kit, outside any repo) or point it outside the working tree",
      };
    }
    return {
      category: "exposure",
      name: "memory store location",
      status: "pass",
      detail: "memory store lives outside the repo working tree",
    };
  } catch {
    return { category: "exposure", name: "memory store location", status: "skip", detail: "could not resolve memory store / repo root" };
  }
}
