import type { ScannerReportGap } from "./check-scanner-evidence.js";
import type { kitConfig } from "./config.js";
import { sanitizeDisplayText } from "./display-text.js";
import { collectImages, configuredImages, imageScanners } from "./image-scan.js";
import { planMavenSbomScans } from "./maven-sbom.js";
import { resolveProjectPaths } from "./projects-config.js";
import { expandPerProject } from "./scan-projects.js";
import {
  enabledScanners,
  SCANNERS,
  type ScanGate,
  type ScanGateOptions,
  type ScannerDef,
} from "./scanners.js";

export interface ScanScopeGap {
  kind: "project" | "image" | "maven" | "threat-data";
  target: string;
  reason: string;
  evidenceStatus: ScannerReportGap | "stale";
}

interface ImagePlan {
  target: string;
  scanners: ScannerDef[];
}

interface ScanPlan {
  scanners: ScannerDef[];
  gaps: ScanScopeGap[];
  images: ImagePlan[];
}

function displayGap(gap: ScanScopeGap): ScanScopeGap {
  return {
    ...gap,
    target: sanitizeDisplayText(gap.target) || "(unnamed target)",
    reason: sanitizeDisplayText(gap.reason),
  };
}

export function planScans(cwd: string, config: kitConfig): ScanPlan {
  const { delegates } = config.scan ?? {};
  const projects = resolveProjectPaths(cwd, config.projects?.paths);
  const maven = planMavenSbomScans(cwd, delegates);
  const imageInputs = collectImages(cwd, {
    configured: configuredImages(config.scan?.images),
    fromDockerfiles: config.scan?.images_from_dockerfiles === true,
  });
  const images = imageInputs.images.map((image) => ({
    target: image.ref,
    scanners: imageScanners([image], delegates),
  }));
  const gaps: ScanScopeGap[] = [
    ...projects.refused.map(({ path, reason, evidenceStatus }) =>
      displayGap({ kind: "project", target: path, reason, evidenceStatus }),
    ),
    ...imageInputs.skipped.map(({ ref, reason, evidenceStatus }) =>
      displayGap({
        kind: "image",
        target: ref,
        reason,
        evidenceStatus: evidenceStatus ?? "unsupported",
      }),
    ),
    ...maven.gaps.map((gap) => displayGap({ ...gap, kind: "maven" })),
  ];
  const scanners = [
    ...expandPerProject(enabledScanners(SCANNERS, delegates), projects.projects),
    ...maven.scanners,
    ...images.flatMap((image) => image.scanners),
  ];
  return { scanners, gaps, images };
}

/** Requested images still need coverage when no image delegate is left in the plan. */
export function plannedScopeGaps(plan: ScanPlan, active: readonly ScannerDef[]): ScanScopeGap[] {
  const activeIds = new Set(active.map((scanner) => scanner.id));
  const gaps = [...plan.gaps];
  for (const image of plan.images) {
    if (image.scanners.some((scanner) => activeIds.has(scanner.id))) continue;
    gaps.push(
      displayGap({
        kind: "image",
        target: image.target,
        evidenceStatus: "unsupported",
        reason: image.scanners.length
          ? "air-gap mode excludes network image scanners"
          : "no image scanner is enabled for this target",
      }),
    );
  }
  return gaps;
}

export function requiredScanIds(
  declared: readonly string[],
  planned: readonly ScannerDef[],
): string[] {
  return [
    ...new Set(
      declared.flatMap((id) => {
        if (id.includes(":")) return [id];
        const matches = planned
          .map((scanner) => scanner.id)
          .filter(
            (name) => name === id || name.startsWith(`${id}:`) || name.startsWith(`${id}-sbom:`),
          );
        return matches.length ? matches : [id];
      }),
    ),
  ];
}

const scopeNoun: Record<ScanScopeGap["kind"], string> = {
  project: "[projects] path",
  image: "image",
  maven: "Maven SBOM",
  "threat-data": "threat-data bundle",
};

export function scanScopeMessage(gap: ScanScopeGap): string {
  return `${scopeNoun[gap.kind]} not scanned: ${gap.target} (${gap.reason})`;
}

function requiredScope(gap: ScanScopeGap, required: readonly string[]): boolean {
  if (gap.kind === "threat-data") return true;
  if (gap.kind === "project") return required.length > 0;
  if (gap.kind === "image") {
    return required.some((id) =>
      ["trivy", "osv-scanner"].some((base) => id === base || id === `${base}:image:${gap.target}`),
    );
  }
  return required.some((id) =>
    ["grype", "osv-scanner"].some((base) => id === base || id === `${base}-sbom:${gap.target}`),
  );
}

export function applyScopeGate(
  gate: ScanGate,
  gaps: readonly ScanScopeGap[],
  options: ScanGateOptions,
): void {
  const required = options.requiredScanners ?? [];
  const uncoveredRequired = gaps.filter((gap) => requiredScope(gap, required)).length;
  const failures = options.strict ? gaps.length : uncoveredRequired;
  const warnings = gaps.length - failures;
  if (failures)
    gate.failures.push(`Scan scope incomplete. ${failures} required target(s) not scanned.`);
  if (warnings) gate.warnings.push(`Scan scope incomplete. ${warnings} target(s) not scanned.`);
  if (failures) gate.ok = false;
}
