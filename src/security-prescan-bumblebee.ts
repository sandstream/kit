import { resolve } from "node:path";
import type { ScannerInstall } from "./bumblebee.js";
import type { PrescanFinding, Severity } from "./security-prescan.js";

function finding(
  repo: string,
  category: string,
  severity: Severity,
  detail: string,
  remediation: string,
): PrescanFinding {
  return { timestamp: new Date().toISOString(), repo, category, severity, detail, remediation };
}

/**
 * One-time staleness check for the bundled exposure catalog. Stale catalogs
 * mean the scanner is detecting old compromises only — new credential-stealing
 * supply-chain attacks won't surface. Surfaced as a single warning across the
 * whole prescan, not per-repo (the catalog is shared).
 */
export async function checkBumblebeeCatalogStale(
  install: ScannerInstall,
  root: string,
): Promise<PrescanFinding[]> {
  try {
    const { newestCatalogMtime, isCatalogStale, CATALOG_STALE_AFTER_DAYS } =
      await import("./bumblebee.js");
    const mtime = await newestCatalogMtime(install.catalogDir);
    if (mtime === null) {
      return [
        finding(
          root,
          "bumblebee-catalog-missing",
          "medium",
          `bumblebee threat_intel catalog directory empty: ${install.catalogDir}`,
          `clear ~/.kit/tools/bumblebee and run any deep scan to re-download`,
        ),
      ];
    }
    const { stale, ageDays } = isCatalogStale(mtime, Date.now());
    if (stale) {
      return [
        finding(
          root,
          "bumblebee-catalog-stale",
          "medium",
          `bumblebee threat_intel catalog is ${ageDays} days old (threshold: ${CATALOG_STALE_AFTER_DAYS}d) — new supply-chain compromises may not be detected`,
          `clear ~/.kit/tools/bumblebee to force a fresh download next deep scan`,
        ),
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Per-repo bumblebee scan. Returns one finding per detected exposure.
 * `install` is hoisted to the caller so the binary is fetched ONCE per
 * prescan run, not 27× — bumblebee install can do an HTTP download.
 */
export async function checkBumblebee(
  repo: string,
  install: ScannerInstall,
): Promise<PrescanFinding[]> {
  try {
    const { runScan } = await import("./bumblebee.js");
    const root = resolve(repo);
    const outcome = await runScan({
      install,
      profile: "project",
      roots: [root],
      cwd: root,
      maxDuration: "60s",
      timeoutMs: 90_000,
    });
    const observations = outcome.findings.map((f) =>
      finding(
        repo,
        "supply-chain",
        (f.severity?.toLowerCase() as Severity) ?? "medium",
        `${f.ecosystem}/${f.packageName}@${f.version} matches catalog ${f.catalogName} (${f.catalogId}) in ${f.sourceFile}`,
        "investigate package; remove if not directly required; pin to last-known-good version",
      ),
    );
    if (outcome.gap) {
      observations.push(
        finding(
          repo,
          "supply-chain",
          "info",
          `Bumblebee scan incomplete: ${outcome.gap.reason}`,
          "Run `kit check` to review scanner coverage",
        ),
      );
    }
    return observations;
  } catch {
    return [
      finding(
        repo,
        "supply-chain",
        "info",
        "bumblebee known-compromise scan errored — supply-chain results may be incomplete",
        "re-run `kit check`; verify the bumblebee binary and catalog are intact",
      ),
    ];
  }
}

export async function prepareBumblebee(
  root: string,
  findings: PrescanFinding[],
): Promise<ScannerInstall | null> {
  let reason = "scanner installation failed";
  try {
    const { ensureBumblebee } = await import("./bumblebee.js");
    const { bumblebeeDownloadAllowed } = await import("./check-security.js");
    const ensured = await ensureBumblebee({ allowDownload: bumblebeeDownloadAllowed() });
    if (ensured.install) return ensured.install;
    reason = ensured.reason ?? reason;
  } catch {
    // Keep the unavailable observation below.
  }
  findings.push(
    finding(
      root,
      "supply-chain",
      "info",
      `Bumblebee scan unavailable: ${reason}`,
      "Run `kit check` to review scanner coverage",
    ),
  );
  return null;
}
