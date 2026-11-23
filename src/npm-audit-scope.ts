import { join } from "node:path";
import { scannerObject, scannerRecord, type ScannerGap } from "./check-scanner-evidence.js";
import { npmAuditArgs, npmAuditGap, readNpmAuditReport } from "./npm-audit-report.js";
import { entryExists, readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

type Lockfile = "npm-shrinkwrap.json" | "package-lock.json";
export interface NpmAuditScope {
  file: Lockfile;
  bytes: Buffer;
  inventory: number;
}

/** npm loads npm-shrinkwrap.json first when both are present. */
export function npmAuditLockfile(root: string): Lockfile | undefined {
  if (entryExists(join(root, "npm-shrinkwrap.json"))) return "npm-shrinkwrap.json";
  if (entryExists(join(root, "package-lock.json"))) return "package-lock.json";
  return undefined;
}

function legacyInventory(dependencies: unknown): number | undefined {
  if (dependencies === undefined) return 0;
  if (!scannerRecord(dependencies)) return undefined;
  const pending = Object.values(dependencies);
  for (const value of pending) {
    if (!scannerRecord(value)) return undefined;
    if (value.dependencies === undefined) continue;
    if (!scannerRecord(value.dependencies)) return undefined;
    for (const dependency of Object.values(value.dependencies)) pending.push(dependency);
  }
  return pending.length;
}

export function readNpmAuditScope(root: string): NpmAuditScope | ScannerGap {
  const file = npmAuditLockfile(root);
  if (!file) return { status: "missing", reason: "no npm lockfile to audit" };
  try {
    const bytes = readRegularFileBytesIfPresent(join(root, file));
    const data = bytes && scannerObject(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || !bytes)
      return { status: "malformed", reason: `${file} is missing or invalid JSON` };
    const { lockfileVersion, packages, dependencies } = data;
    if (lockfileVersion !== 1 && lockfileVersion !== 2 && lockfileVersion !== 3) {
      return { status: "unsupported", reason: `${file} uses an unsupported lockfile version` };
    }
    let inventory: number | undefined;
    if (lockfileVersion === 1) {
      inventory = legacyInventory(dependencies);
    } else if (scannerRecord(packages) && scannerRecord(packages[""])) {
      const entries = Object.values(packages);
      if (entries.every(scannerRecord)) inventory = entries.length - 1;
    }
    if (inventory === undefined) {
      return { status: "malformed", reason: `${file} has no complete package inventory` };
    }
    return { file, bytes, inventory };
  } catch {
    return { status: "malformed", reason: `${file} could not be read as a regular UTF-8 file` };
  }
}

export function npmScopeGap(
  root: string,
  scope: NpmAuditScope,
  reported: number | undefined,
): ScannerGap | undefined {
  const current = readNpmAuditScope(root);
  if ("status" in current || current.file !== scope.file || !scope.bytes.equals(current.bytes)) {
    return { status: "partial", reason: `${scope.file} changed during the audit` };
  }
  if (reported !== scope.inventory) {
    return { status: "partial", reason: `npm audit inventory does not match ${scope.file}` };
  }
  return undefined;
}

/** Bind the delegate report's inventory to the selected lockfile in the requested directory. */
export async function runNpmAudit(root: string, timeout: number) {
  const scope = readNpmAuditScope(root);
  if ("status" in scope) return { report: readNpmAuditReport(""), gap: scope };
  const result = await execFileNoThrow("npm", npmAuditArgs("high"), { cwd: root, timeout });
  const report = readNpmAuditReport(result.stdout);
  const gap = npmAuditGap(report, result, "high") ?? npmScopeGap(root, scope, report.inventory);
  return { report, gap };
}
