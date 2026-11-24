import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { scannerObject, scannerRecord } from "./check-scanner-evidence.js";
import { expectedTrivyConfigKey, trivyConfigKey } from "./trivy-report.js";
import type { ScannerEvidence } from "./scan-result.js";

export type TrivyMode = "trivy-fs" | "trivy-config" | "trivy-image";

export interface TrivyFinding {
  id: string;
  level: "error" | "warning" | "note";
  message: string;
  packageLabel?: string;
  target?: string;
  line?: number;
  score: string;
  secret?: true;
}

type Report = {
  evidence: ScannerEvidence;
  findings: TrivyFinding[];
  convertible: boolean;
};

interface Inventory {
  packageCount: number;
  checkCount: number;
  partial: boolean;
  checkedConfig: Set<string>;
  findings: TrivyFinding[];
}

function partial(
  reason: string,
  reportGap: "missing" | "partial" | "malformed" | "unsupported" = "partial",
): ScannerEvidence {
  return { status: "partial", reportGap, reason };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function withinRoot(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local);
}

function localTarget(root: string, target: string, allowDirectory = false): boolean {
  if (target.split(/[\\/]/).includes("..")) return false;
  const path = resolve(root, target);
  if (!withinRoot(root, path)) return false;
  try {
    const realPath = realpathSync(path);
    if (!withinRoot(root, realPath)) return false;
    const entry = statSync(realPath);
    return entry.isFile() || (allowDirectory && entry.isDirectory());
  } catch {
    return false;
  }
}

function matchesImage(metadata: unknown, ref: string): boolean {
  if (
    !scannerRecord(metadata) ||
    typeof metadata.ImageID !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.ImageID)
  )
    return false;
  const references = ref.includes("@") ? metadata.RepoDigests : metadata.RepoTags;
  return Array.isArray(references) && references.includes(ref);
}

function matchesSource(report: Record<string, unknown>, mode: TrivyMode, target: string): boolean {
  if (report.ArtifactName !== target) return false;
  if (mode === "trivy-image")
    return report.ArtifactType === "container_image" && matchesImage(report.Metadata, target);
  return report.ArtifactType === "filesystem";
}

function isPackage(value: unknown): boolean {
  return (
    scannerRecord(value) && nonempty(value.ID) && nonempty(value.Name) && nonempty(value.Version)
  );
}

function checkSummary(value: unknown, failures: number): number | undefined {
  if (!scannerRecord(value)) return undefined;
  if ((value.Failures ?? 0) !== failures) return undefined;
  const counts = [value.Successes, value.Failures, value.Exceptions];
  if (!counts.some((count) => count !== undefined)) return undefined;
  let sum = 0;
  for (const count of counts) {
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
    sum += count;
  }
  if (!Number.isSafeInteger(sum)) return undefined;
  return sum - ((value.Exceptions ?? 0) as number);
}

const scores: Readonly<Record<string, string>> = {
  CRITICAL: "9.5",
  HIGH: "8.0",
  MEDIUM: "5.5",
  LOW: "2.0",
  UNKNOWN: "0.0",
};

function nativeScore(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(scores, value) ? scores[value] : undefined;
}

function startLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Trivy's SARIF writer uses an image repository, without the registry or version, for OS findings. */
function imageRepository(reference: string): string {
  const digestFree = reference.split("@")[0]!;
  const separator = digestFree.lastIndexOf(":");
  const untagged =
    separator > digestFree.lastIndexOf("/") ? digestFree.slice(0, separator) : digestFree;
  const [first, ...rest] = untagged.split("/");
  if (rest.length && (first!.includes(".") || first!.includes(":") || first === "localhost"))
    return rest.length === 1 && (first === "docker.io" || first === "index.docker.io")
      ? "library/" + rest[0]
      : rest.join("/");
  return rest.length ? untagged : "library/" + untagged;
}

function findingTarget(
  result: Record<string, unknown>,
  row: Record<string, unknown>,
  mode: TrivyMode,
): string | undefined {
  const target = nonempty(row.PkgPath) ? row.PkgPath : result.Target;
  if (!nonempty(target)) return undefined;
  if (mode === "trivy-image" && result.Class === "os-pkgs")
    return imageRepository(target.replace(/\s*\([^)]*\).*$/, ""));
  return target.replaceAll("\\", "/");
}

const findingIds = {
  Vulnerabilities: "VulnerabilityID",
  Misconfigurations: "ID",
  Secrets: "RuleID",
} as const;
type FindingType = keyof typeof findingIds;

function fallbackFinding(
  type: FindingType,
  row: Record<string, unknown>,
  result: Record<string, unknown>,
  mode: TrivyMode,
): TrivyFinding | undefined {
  const id = row[findingIds[type]];
  if (!nonempty(id)) return undefined;
  const severity = row.Severity;
  const level =
    severity === "HIGH" || severity === "CRITICAL"
      ? "error"
      : severity === "MEDIUM"
        ? "warning"
        : "note";
  const packageLabel =
    nonempty(row.PkgName) && nonempty(row.InstalledVersion)
      ? `Package: ${row.PkgName}\nInstalled Version: ${row.InstalledVersion}\n`
      : undefined;
  // A secret report's Match and code excerpt are intentionally excluded.
  const message =
    type === "Secrets"
      ? "Trivy reported a secret finding"
      : (packageLabel ?? "") + (nonempty(row.Title) ? row.Title : id);
  const score = nativeScore(severity);
  const causeLine = scannerRecord(row.CauseMetadata) ? row.CauseMetadata.StartLine : undefined;
  return {
    id,
    level,
    message,
    packageLabel,
    score: score ?? "0.0",
    target: findingTarget(result, row, mode),
    line: startLine(row.StartLine ?? causeLine),
    ...(type === "Secrets" ? { secret: true } : {}),
  };
}

function collectFindings(
  row: Record<string, unknown>,
  type: FindingType,
  inventory: Inventory,
  mode: TrivyMode,
): void {
  const entries = row[type];
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    inventory.partial = true;
    return;
  }
  for (const entry of entries) {
    if (!scannerRecord(entry)) {
      inventory.partial = true;
      continue;
    }
    if (type === "Misconfigurations") {
      if (entry.Status === "PASS" || entry.Status === "EXCEPTION") continue;
      if (entry.Status !== "FAIL") inventory.partial = true;
    }
    const finding = fallbackFinding(type, entry, row, mode);
    if (finding) inventory.findings.push(finding);
    if (!finding || nativeScore(entry.Severity) === undefined) inventory.partial = true;
  }
}

function findingsMatchPackages(rows: unknown, packages: unknown[]): boolean {
  if (rows === undefined) return true;
  if (!Array.isArray(rows)) return false;
  const identities = new Set(
    packages.filter(scannerRecord).map(({ Name, Version }) => JSON.stringify([Name, Version])),
  );
  return rows.every(
    (row) =>
      scannerRecord(row) && identities.has(JSON.stringify([row.PkgName, row.InstalledVersion])),
  );
}

function recordPackageScope(row: Record<string, unknown>, inventory: Inventory): void {
  const value = row.Packages;
  if (
    !Array.isArray(value) ||
    !value.every(isPackage) ||
    !findingsMatchPackages(row.Vulnerabilities, value)
  ) {
    inventory.partial = true;
    return;
  }
  inventory.packageCount += value.length;
}

function readTarget(value: unknown, mode: TrivyMode, root: string, inventory: Inventory): void {
  if (!scannerRecord(value)) {
    inventory.partial = true;
    return;
  }
  const previous = inventory.findings.length;
  collectFindings(value, "Misconfigurations", inventory, mode);
  const misconfigurations = inventory.findings.length - previous;
  collectFindings(value, "Vulnerabilities", inventory, mode);
  collectFindings(value, "Secrets", inventory, mode);
  if (
    !nonempty(value.Target) ||
    !nonempty(value.Type) ||
    (mode !== "trivy-image" &&
      !localTarget(root, value.Target, value.Class === "config" && value.Type === "terraform"))
  ) {
    inventory.partial = true;
    return;
  }
  if (mode === "trivy-config" && value.Class !== "config") {
    inventory.partial = true;
    return;
  }
  if (value.Class === "lang-pkgs" || value.Class === "os-pkgs") {
    recordPackageScope(value, inventory);
  } else if (value.Class === "config") {
    const count = checkSummary(value.MisconfSummary, misconfigurations);
    if (count === undefined) inventory.partial = true;
    else if (count > 0) {
      inventory.checkCount += count;
      inventory.checkedConfig.add(trivyConfigKey(value.Type, value.Target));
    }
  } else if (value.Class !== "secret") {
    inventory.partial = true;
  }
}

function evidenceFor(inventory: Inventory, mode: TrivyMode): ScannerEvidence {
  if (inventory.partial) return partial("Trivy reported incomplete or unreadable target evidence");
  const { packageCount, checkCount } = inventory;
  if (mode === "trivy-config" ? checkCount : packageCount)
    return {
      status: "complete",
      ...(packageCount ? { packageCount } : {}),
      ...(checkCount ? { checkCount } : {}),
    };
  if (inventory.findings.length) return partial("Trivy findings have no complete target inventory");
  return {
    status: "not-applicable",
    reason: "Trivy reported no package or configuration coverage",
  };
}

export function readTrivyReport(
  text: string,
  mode: TrivyMode,
  target: string,
  root: string,
  expectedConfig: readonly string[] = [],
): Report {
  const report = scannerObject(text);
  if (!report)
    return {
      evidence: partial(
        text.trim() ? "Trivy emitted invalid native JSON" : "Trivy native report is missing",
        text.trim() ? "malformed" : "missing",
      ),
      findings: [],
      convertible: false,
    };
  const inventory: Inventory = {
    packageCount: 0,
    checkCount: 0,
    partial: false,
    findings: [],
    checkedConfig: new Set(),
  };
  if (Array.isArray(report.Results))
    for (const row of report.Results) readTarget(row, mode, root, inventory);
  else if (report.Results !== undefined) inventory.partial = true;

  let evidence = evidenceFor(inventory, mode);
  if (report.SchemaVersion !== 2)
    evidence = partial("Trivy native report uses an unsupported schema", "unsupported");
  else if (!matchesSource(report, mode, target))
    evidence = partial("Trivy native report does not identify the requested source");
  else if (
    mode === "trivy-config" &&
    expectedConfig.some((path) => !inventory.checkedConfig.has(expectedTrivyConfigKey(path)))
  )
    evidence = partial("Trivy did not establish coverage for all expected configuration targets");
  return { evidence, findings: inventory.findings, convertible: report.SchemaVersion === 2 };
}
