import type { HealthFinding } from "./health.js";
import type { SyncFinding } from "./memory/pal.js";

export function actionableHealth(findings: HealthFinding[]): HealthFinding[] {
  return findings.filter((f) => f.status === "red");
}

export function healthFindingToSync(f: HealthFinding): SyncFinding {
  return {
    dedupKey: `${f.sensor}:${f.title}`,
    title: f.title,
    detail: f.detail || undefined,
  };
}

/** Mirror red health findings into PAL under the "health" source tag. Fail-open. */
export async function syncHealthFindings(
  findings: HealthFinding[],
): Promise<{ added: number; reopened: number; closed: string[] } | null> {
  try {
    const { openMemoryDb } = await import("./memory/db.js");
    const { palSyncFindings } = await import("./memory/pal.js");
    const { getCurrentProjectRoot } = await import("./memory/project.js");
    const { basename } = await import("node:path");
    const scope = basename(getCurrentProjectRoot());
    const db = openMemoryDb();
    try {
      return palSyncFindings(db, "health", actionableHealth(findings).map(healthFindingToSync), {
        scope,
      });
    } finally {
      db.close();
    }
  } catch {
    return null; // fail-open: health reporting must never break a command
  }
}
