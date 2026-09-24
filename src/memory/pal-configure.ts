import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PendingAction, VerifyCheck } from "./pal.js";
import { createActionGrant, removeActionGrant } from "./pal-authority.js";

/** One declarative grammar for explicit configuration and persisted definitions. */
export function parseVerifyCheck(value: unknown): VerifyCheck | null {
  if (!value || typeof value !== "object") return null;
  const check = value as Record<string, unknown>;
  if (check.type === "file-exists" && typeof check.path === "string") {
    return check.path.length > 0 && !check.path.includes("\0")
      ? { type: "file-exists", path: check.path }
      : null;
  }
  if (
    check.type !== "http-status" ||
    typeof check.url !== "string" ||
    typeof check.expect !== "number" ||
    !Number.isInteger(check.expect) ||
    check.expect < 100 ||
    check.expect > 599
  )
    return null;
  try {
    const url = new URL(check.url);
    if (["http:", "https:"].includes(url.protocol))
      return { type: "http-status", url: url.href, expect: check.expect };
  } catch {
    return null;
  }
  return null;
}

function configuredCheck(check: VerifyCheck): VerifyCheck {
  const parsed = parseVerifyCheck(check);
  if (!parsed) throw new RangeError("Invalid declarative file or HTTP verification check");
  return parsed.type === "file-exists" ? { ...parsed, path: resolve(parsed.path) } : parsed;
}

/** Explicit local configuration; owns its transaction so marker cleanup follows commit. */
export function palConfigure(db: DatabaseSync, id: string, check: VerifyCheck | null): boolean {
  const definition = check === null ? null : JSON.stringify(configuredCheck(check));
  let grant: string | null = null;
  let oldGrant: string | null | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as unknown as
      | PendingAction
      | undefined;
    if (!row) {
      db.exec("COMMIT");
      return false;
    }
    oldGrant = row.verify_grant;
    if (definition) grant = createActionGrant(db, { ...row, verify_check: definition });
    db.prepare(
      `UPDATE pending_actions SET kind = ?, verify_definition = ?, verify_grant = ?,
       verify_passes = 0 WHERE id = ?`,
    ).run(check === null ? "manual" : "auto", definition, grant, id);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have aborted the transaction; preserve the original failure.
    }
    removeActionGrant(db, grant);
    throw error;
  }
  if (oldGrant !== grant) removeActionGrant(db, oldGrant);
  return true;
}
