/**
 * kit memory — shared project / responsibility-area memory (the curated tier).
 *
 * This is CONTEXT, not raw memory: durable, curated, intentional knowledge that
 * is safe to share with the team and travels with the repo. Treated LIKE CODE:
 *  - committed TEXT (.kit/shared/memory.jsonl) → diffable, PR-reviewable, gitleaks-scannable;
 *  - deny-by-default — nothing is auto-shared, you promote entries explicitly;
 *  - allow-listed schema — only safe fields (no raw dumps);
 *  - fail-closed secret-scan on write (reuses kit's SECRET_PATTERNS);
 *  - provenance + receipts (author + source_ref) so colleagues can trust it.
 *
 * Organized by `area` (e.g. "stripe", "whatsapp", "plugins") so a growing system
 * stays navigable: "how did we build X, what's next, is it secure?" = that area's
 * entries (with receipts). Entries are few (curated) → plain JSONL + JS query; no
 * second database. Querying never calls a model.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { findSecrets } from "../utils/redactSecrets.js";

export type SharedKind =
  | "decision"
  | "convention"
  | "how-built"
  | "status"
  | "security"
  | "note";

export interface SharedEntry {
  id: string;
  area: string;
  kind: SharedKind;
  title: string;
  body: string;
  refs: string[];
  author: string;
  ts: string;
  source_ref?: string;
}

export interface ShareInput {
  area: string;
  kind: SharedKind;
  title: string;
  body: string;
  refs?: string[];
}

export function getSharedPath(root: string): string {
  return join(root, ".kit", "shared", "memory.jsonl");
}

function gitAuthor(root: string): string {
  const read = (key: string): string => {
    try {
      return execFileSync("git", ["config", key], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (name && email) return `${name} <${email}>`;
  return name || email || "unknown";
}

function gitHead(root: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export function readShared(root: string): SharedEntry[] {
  const path = getSharedPath(root);
  if (!existsSync(path)) return [];
  const out: SharedEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SharedEntry);
    } catch {
      // skip malformed lines, keep the rest readable
    }
  }
  return out;
}

/**
 * Promote one entry into the shared store. Fail-closed: refuses (throws) if any
 * text field contains a secret. Only allow-listed fields are persisted — no raw
 * tool output / env dumps can sneak in. Author + source_ref give provenance.
 */
export function shareEntry(root: string, input: ShareInput, now: string): SharedEntry {
  const refs = input.refs ?? [];
  const scanned = [input.title, input.body, ...refs].join("\n");
  const found = findSecrets(scanned);
  if (found.length) {
    throw new Error(
      `refused: entry contains ${found.length} secret(s) (${found
        .map((f) => f.label)
        .join(", ")}) — shared memory must be secret-clean`,
    );
  }
  const entry: SharedEntry = {
    id: randomBytes(3).toString("hex"),
    area: input.area,
    kind: input.kind,
    title: input.title,
    body: input.body,
    refs,
    author: gitAuthor(root),
    ts: now,
    source_ref: gitHead(root),
  };
  const path = getSharedPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
  return entry;
}

export function listAreas(root: string): { area: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of readShared(root)) counts.set(e.area, (counts.get(e.area) ?? 0) + 1);
  return [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => a.area.localeCompare(b.area));
}

export function queryArea(root: string, area: string): SharedEntry[] {
  return readShared(root).filter((e) => e.area === area);
}

export function searchShared(root: string, query: string): SharedEntry[] {
  const q = query.toLowerCase();
  return readShared(root).filter(
    (e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q),
  );
}
