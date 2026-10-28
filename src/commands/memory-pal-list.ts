import { existsSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { isReadOnlyMode } from "../read-only-mode.js";
import { getMemoryDbPath, openMemoryDb, openMemoryDbReadOnly } from "../memory/db.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import { getCanonicalProjectRoot } from "../memory/canonical-root.js";
import { scanPlanFiles, syncPlanFiles } from "../memory/plan-track.js";
import { palList, pendingActionOrigin, type PendingAction } from "../memory/pal.js";
import { sanitizeForPrompt } from "../memory/injection.js";

function openListDb(): { db: ReturnType<typeof openMemoryDb>; readOnly: boolean } | null {
  if (!existsSync(getMemoryDbPath())) {
    const scan = isReadOnlyMode() ? null : scanPlanFiles(getCanonicalProjectRoot());
    if (scan?.issues.length)
      console.error(`kit: plan scan incomplete (${scan.issues.join("; ")}); PAL was not changed`);
    const needsStore = scan?.issues.length === 0 && scan.plans.some((p) => p.state !== "complete");
    if (!needsStore) return null;
  }
  const readOnly = isReadOnlyMode();
  try {
    return { db: readOnly ? openMemoryDbReadOnly() : openMemoryDb(), readOnly };
  } catch (err) {
    if (readOnly) throw err;
    return { db: openMemoryDbReadOnly(), readOnly: true };
  }
}

function renderItems(items: PendingAction[], status: string, jsonMode: boolean): boolean {
  if (jsonMode) {
    console.log(JSON.stringify(items));
    return true;
  }
  if (!items.length) {
    console.log(`${c.dim}no ${status} action items${c.reset}`);
    return true;
  }
  console.log(`${c.bold}${items.length}${c.reset} ${status} action item(s):`);
  for (const p of items) {
    const tag = p.kind === "auto" ? ` ${c.dim}· auto${c.reset}` : "";
    const scopeText = p.scope ? ` ${c.dim}[${p.scope}]${c.reset}` : "";
    console.log(`  ${c.bold}${p.id}${c.reset}  ${p.title}${scopeText}${tag}`);
    const origin = sanitizeForPrompt(pendingActionOrigin(p)).text.replace(/\s+/g, " ");
    if (origin) console.log(`    ${c.dim}${origin}${c.reset}`);
    if (p.status === "claimed") {
      const identity = p.claim_owner;
      const owner = sanitizeForPrompt(
        identity
          ? `${p.claimed_by ?? identity.harness}; device=${identity.device}; harness=${identity.harness}; session=${identity.session}`
          : `${p.claimed_by ?? "unknown"}; unknown legacy session; explicit takeover required`,
      ).text.replace(/\s+/g, " ");
      console.log(`    ${c.dim}claimed by ${owner}${c.reset}`);
    }
  }
  return true;
}

export function memPalList(status: string, jsonMode: boolean): boolean {
  const opened = openListDb();
  if (!opened) return renderItems([], status, jsonMode);
  const { db, readOnly } = opened;
  try {
    if (!readOnly) {
      const plans = syncPlanFiles(db, getCanonicalProjectRoot());
      if (plans.issues.length)
        console.error(
          `kit: plan scan incomplete (${plans.issues.join("; ")}); PAL was not changed`,
        );
    }
    const scope = hasFlag(process.argv, "--global") ? undefined : getCurrentProjectRoot();
    const items = palList(db, {
      status,
      scope,
      allDevices: hasFlag(process.argv, "--all"),
      conflictsOnly: hasFlag(process.argv, "--conflicts"),
      readOnly,
    });
    return renderItems(items, status, jsonMode);
  } finally {
    db.close();
  }
}
