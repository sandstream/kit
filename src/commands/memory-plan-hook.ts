import { existsSync } from "node:fs";
import { isReadOnlyMode } from "../read-only-mode.js";
import { getCanonicalProjectRoot } from "../memory/canonical-root.js";
import { getMemoryDbPath, openMemoryDb } from "../memory/db.js";
import { scanPlanFiles, syncPlanFiles } from "../memory/plan-track.js";

/** Keep plan tracking fail-open at SessionStart, with one short context line. */
export function planSessionStartNotice(): string | null {
  if (isReadOnlyMode()) return null;
  try {
    const root = getCanonicalProjectRoot();
    const scan = scanPlanFiles(root);
    if (scan.issues.length) return "Plan scan incomplete. Run kit memory pal list for details.";
    if (!existsSync(getMemoryDbPath()) && !scan.plans.some((p) => p.state !== "complete"))
      return null;
    const db = openMemoryDb();
    try {
      const plans = syncPlanFiles(db, root);
      if (plans.issues.length) return "Plan scan incomplete. Run kit memory pal list for details.";
      if (!plans.pending.length) return null;
      const names = plans.pending.slice(0, 3).join(", ");
      const more = plans.pending.length > 3 ? ` and ${plans.pending.length - 3} more` : "";
      return `Open plan files: ${names}${more}. Use kit memory pal list.`;
    } finally {
      db.close();
    }
  } catch {
    return "Plan tracking unavailable. Run kit memory pal list for details.";
  }
}

export function planSessionStartLines(pullNote?: string): string[] {
  const lines: string[] = [];
  if (pullNote) lines.push(pullNote);
  const planNote = planSessionStartNotice();
  if (planNote) lines.push(planNote);
  return lines;
}
