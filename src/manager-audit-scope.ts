import { join } from "node:path";
import { readBunAuditScope } from "./bun-audit-scope.js";
import { scannerObject, scannerRecord, type ScannerGap } from "./check-scanner-evidence.js";
import {
  auditConfigFiles,
  hasCustomAuditRegistry,
  verifiedConfig,
  type Manager,
} from "./manager-audit-config.js";
import { entryExists, readRegularFileBytesIfPresent } from "./upstream-safe-read.js";

interface ReadInput {
  path: string;
  bytes: Buffer | null;
}

export interface ManagerAuditScope {
  manager: Manager;
  inputs: ReadInput[];
  bunPackages?: ReadonlySet<string>;
  bunLock?: Buffer;
  gap?: ScannerGap;
}

export function isAdditionalManager(manager: string): manager is Manager {
  return manager === "bun" || manager === "pnpm" || manager === "yarn";
}

function unsupported(reason: string): ScannerGap {
  return { status: "unsupported", reason };
}

function readText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function manifestGap(data: Record<string, unknown>, manager: Manager): ScannerGap | undefined {
  const declared = data.packageManager;
  if (
    declared !== undefined &&
    (typeof declared !== "string" ||
      !new RegExp(`^${manager}@\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$`).test(declared))
  ) {
    return unsupported(
      "package.json does not select a supported registry release of the audit manager",
    );
  }
  const settings = data[manager];
  if (
    scannerRecord(settings) &&
    ["audit", "auditConfig", "registry", "registries"].some((key) => Object.hasOwn(settings, key))
  )
    return unsupported(
      "package.json contains audit or registry configuration outside the verified scope",
    );
  return undefined;
}

function yarnLockGap(text: string): ScannerGap | undefined {
  if (!/^__metadata:\s*\r?\n +version: +\d+/m.test(text)) {
    return unsupported("Yarn audit requires a supported Yarn Berry lockfile");
  }
  const resolutions = [...text.matchAll(/^ {2}resolution:\s*"?([^"\r\n]+)"?\s*$/gm)];
  if (resolutions.length === 0)
    return { status: "malformed", reason: "Yarn lockfile contains no resolution inventory" };
  if (resolutions.some(([, value]) => !/@(?:npm|workspace):/.test(value))) {
    return {
      status: "partial",
      reason: "Yarn lockfile contains dependencies outside Yarn's npm advisory scope",
    };
  }
  return undefined;
}

function scopeOfLock(
  manager: Manager,
  bytes: Buffer,
): Omit<ManagerAuditScope, "manager" | "inputs"> {
  const text = readText(bytes);
  if (manager === "bun") {
    const bun = readBunAuditScope(text);
    return "status" in bun ? { gap: bun } : { bunPackages: bun, bunLock: bytes };
  }
  if (manager === "yarn") return { gap: yarnLockGap(text) };
  if (!/^lockfileVersion:\s*['"]?\d+(?:\.\d+)?['"]?\s*$/m.test(text))
    return { gap: { status: "malformed", reason: "pnpm lockfile has no format version" } };
  return {};
}

function lockfileOf(root: string, manager: Manager): string {
  if (manager === "bun") return join(root, "bun.lock");
  return join(root, manager === "pnpm" ? "pnpm-lock.yaml" : "yarn.lock");
}

function observeManifest(root: string, manager: Manager): ReadInput | ScannerGap {
  const path = join(root, "package.json");
  const bytes = readRegularFileBytesIfPresent(path);
  const manifest = bytes && scannerObject(readText(bytes));
  if (!manifest) return { status: "malformed", reason: "package.json is missing or invalid" };
  return manifestGap(manifest, manager) ?? { path, bytes };
}

function observeConfiguration(
  root: string,
  manager: Manager,
  env: NodeJS.ProcessEnv,
): ReadInput[] | ScannerGap {
  const observed: ReadInput[] = [];
  for (const path of auditConfigFiles(root, manager, env)) {
    const bytes = readRegularFileBytesIfPresent(path);
    if (
      manager === "pnpm" &&
      bytes &&
      path.endsWith("pnpm-workspace.yaml") &&
      path !== join(root, "pnpm-workspace.yaml")
    )
      return unsupported("pnpm audit scope is ambiguous under a parent workspace");
    if (bytes && !verifiedConfig(path, readText(bytes)))
      return unsupported(
        "package manager settings could change audit coverage or load an external tool",
      );
    observed.push({ path, bytes });
  }
  return observed;
}

/** Capture the actual lockfile and the audit-affecting inputs before launching the manager. */
export function readManagerAuditScope(
  root: string,
  manager: Manager,
  env: NodeJS.ProcessEnv,
): ManagerAuditScope | ScannerGap {
  try {
    if (hasCustomAuditRegistry(env))
      return unsupported(
        "audit environment selects registry configuration outside the verified scope",
      );
    if (manager === "bun" && entryExists(join(root, "bun.lockb")))
      return unsupported("Bun audit scope for a binary or mixed lockfile is unverified");
    const lockfile = lockfileOf(root, manager);
    const lock = readRegularFileBytesIfPresent(lockfile);
    if (!lock) return { status: "missing", reason: "package manager lockfile is missing" };
    const lockScope = scopeOfLock(manager, lock);
    if (lockScope.gap && lockScope.gap.status !== "partial") return lockScope.gap;

    const manifest = observeManifest(root, manager);
    if ("status" in manifest) return manifest;
    const configs = observeConfiguration(root, manager, env);
    if ("status" in configs) return configs;
    const inputs = [{ path: lockfile, bytes: lock }, manifest, ...configs];
    if (manager === "bun") inputs.push({ path: join(root, "bun.lockb"), bytes: null });
    return { manager, inputs, ...lockScope };
  } catch {
    return {
      status: "malformed",
      reason: "package manager scope could not be read as bounded regular UTF-8 files",
    };
  }
}

export function managerScopeChanged({ inputs }: ManagerAuditScope): boolean {
  try {
    return inputs.some(({ path, bytes }) => {
      const now = readRegularFileBytesIfPresent(path);
      return bytes === null ? now !== null : now === null || !bytes.equals(now);
    });
  } catch {
    return true;
  }
}
