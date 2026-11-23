import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { scannerObject, scannerRecord } from "./check-scanner-evidence.js";
import type { InventoryFinding, ScannerEvidence, ScannerProcess } from "./scan-result.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";

function inside(root: string, name: string): boolean {
  const path = relative(root, name);
  return path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function scopedFile(root: string, path: string): boolean {
  if (!inside(root, path)) return false;
  try {
    return inside(root, realpathSync(path)) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function scopedLocation(root: string, path: unknown): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return scopedFile(root, join(root, ...parts));
}

function isLocation(property: unknown): property is Record<string, unknown> {
  return (
    scannerRecord(property) &&
    typeof property.name === "string" &&
    /^syft:location:\d+:path$/.test(property.name)
  );
}

function matchesPackageUrl(url: unknown, name: string, version: string): boolean {
  if (typeof url !== "string") return false;
  const parts = /^pkg:[a-z][a-z0-9.+-]*\/([^?#\s]+)@([^/?#\s]+)(?:[?#].*)?$/.exec(url);
  if (!parts) return false;
  try {
    const urlName = decodeURIComponent(parts[1]!).toLowerCase();
    const expectedName = name.toLowerCase();
    return (
      (urlName === expectedName || urlName.endsWith("/" + expectedName)) &&
      decodeURIComponent(parts[2]!) === version
    );
  } catch {
    return false;
  }
}

type PackageIdentity = { name: string; version: string };
type ScopedPackages = ReadonlyMap<string, PackageIdentity>;

function readPackage(
  component: Record<string, unknown>,
  root: string,
): [string, PackageIdentity] | undefined {
  const { name, version, purl, properties } = component;
  const reference = component["bom-ref"];
  if (
    typeof name !== "string" ||
    !name ||
    typeof version !== "string" ||
    typeof reference !== "string" ||
    !reference ||
    !matchesPackageUrl(purl, name, version) ||
    !Array.isArray(properties)
  )
    return undefined;
  const locations = properties.filter(isLocation);
  if (!locations.length || !locations.every((entry) => scopedLocation(root, entry.value)))
    return undefined;
  return [reference, { name, version }];
}

function readScopedPackages(components: unknown, root: string): ScopedPackages | undefined {
  if (!Array.isArray(components)) return undefined;
  const packages = new Map<string, PackageIdentity>();
  for (const component of components) {
    if (!scannerRecord(component)) return undefined;
    if (component.type === "file") {
      if (
        typeof component.name !== "string" ||
        !isAbsolute(component.name) ||
        !scopedFile(root, component.name)
      )
        return undefined;
      continue;
    }
    if (
      component.type !== "library" &&
      component.type !== "application" &&
      component.type !== "framework" &&
      component.type !== "operating-system"
    )
      return undefined;
    const entry = readPackage(component, root);
    if (!entry || packages.has(entry[0])) return undefined;
    packages.set(...entry);
  }
  return packages;
}

function reportedFindings(
  value: unknown,
  packages: ScopedPackages,
): InventoryFinding[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const findings = new Map<string, InventoryFinding>();
  for (const entry of value) {
    if (
      !scannerRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      !Array.isArray(entry.affects) ||
      entry.affects.length === 0
    )
      return undefined;
    for (const affected of entry.affects) {
      if (!scannerRecord(affected) || typeof affected.ref !== "string") return undefined;
      const pkg = packages.get(affected.ref);
      if (!pkg) return undefined;
      findings.set(JSON.stringify([entry.id, affected.ref]), {
        name: `grype: ${entry.id}-${pkg.name}`,
        version: pkg.version,
      });
    }
  }
  return [...findings.values()];
}

function scopeMatches(read: Record<string, unknown>, root: string): boolean {
  if (!scannerRecord(read.metadata) || !scannerRecord(read.metadata.component)) return false;
  if (read.metadata.component.name !== root || read.metadata.component.type !== "file")
    return false;
  const tools = read.metadata.tools;
  return (
    scannerRecord(tools) &&
    Array.isArray(tools.components) &&
    tools.components.some((item) => scannerRecord(item) && item.name === "grype")
  );
}

export function readGrypeDirectoryCoverage(text: string | null, root: string): ScannerEvidence {
  if (text === null)
    return {
      status: "partial",
      reportGap: "missing",
      reason: "Grype package inventory is missing",
    };
  const read = scannerObject(text);
  if (
    read?.bomFormat !== "CycloneDX" ||
    typeof read.specVersion !== "string" ||
    !scopeMatches(read, root)
  )
    return {
      status: "partial",
      reportGap: "malformed",
      reason: "Grype inventory does not identify the scanned directory",
    };
  if (!["1.6", "1.7"].includes(read.specVersion))
    return {
      status: "partial",
      reportGap: "unsupported",
      reason: "Grype inventory uses an unsupported CycloneDX version",
    };
  const packages = readScopedPackages(read.components === undefined ? [] : read.components, root);
  if (!packages)
    return {
      status: "partial",
      reportGap: "partial",
      reason: "Grype inventory contains unreadable or out-of-scope components",
    };
  const requiredFindings = reportedFindings(read.vulnerabilities, packages);
  if (!requiredFindings)
    return {
      status: "partial",
      reportGap: "partial",
      reason: "Grype inventory contains unbound vulnerabilities",
    };
  return packages.size === 0
    ? {
        status: "not-applicable",
        reason: "Grype reported no packages within the scanned directory",
      }
    : {
        status: "complete",
        packageCount: packages.size,
        ...(requiredFindings.length ? { requiredFindings } : {}),
      };
}

function fileEvidence(report: string, root: string): ScannerEvidence {
  try {
    const bytes = readRegularFileBytesIfPresent(report);
    const text = bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return readGrypeDirectoryCoverage(text, root);
  } catch {
    return {
      status: "partial",
      reportGap: "malformed",
      reason: "Grype package inventory could not be read",
    };
  }
}

export async function runGrypeDirectory(
  cwd: string,
  args: string[],
  run: (args: string[], cwd: string) => Promise<ScannerProcess>,
): Promise<ScannerProcess> {
  let root: string;
  let work: string;
  try {
    root = realpathSync(cwd);
    work = mkdtempSync(join(tmpdir(), "kit-grype-coverage-"));
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: "Unable to prepare Grype directory scope",
      noNumericExitStatus: true,
    };
  }
  let process: ScannerProcess;
  let cleanupFailed = false;
  try {
    const report = join(work, "scope.json");
    process = await run(["dir:" + root, ...args.slice(1), "-o", "cyclonedx-json=" + report], root);
    process = { ...process, evidence: fileEvidence(report, root) };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      cleanupFailed = true;
    }
  }
  return cleanupFailed
    ? {
        ...process,
        evidence: {
          status: "partial",
          reportGap: "partial",
          reason: "Grype inventory workspace cleanup failed",
        },
      }
    : process;
}
