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

export type SharedKind = "decision" | "convention" | "how-built" | "status" | "security" | "note";

/**
 * Lifecycle of a decision. Append-only: we never edit an old entry, a change is a
 * NEW entry that `supersedes`/`reverses` the old id. "active" is the default and
 * is left IMPLICIT (absent field) so existing/committed entries stay byte-identical.
 */
export type SharedStatus = "active" | "superseded" | "reversed";

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
  /** Explicit lifecycle marker; absent ⇒ active (unless a later entry supersedes/reverses it). */
  status?: SharedStatus;
  /** Id of the entry this one replaces (its successor). */
  supersedes?: string;
  /** Id of the entry this one reverses (tried + undone — re-introducing it should warn). */
  reverses?: string;
}

export interface ShareInput {
  area: string;
  kind: SharedKind;
  title: string;
  body: string;
  refs?: string[];
  status?: SharedStatus;
  supersedes?: string;
  reverses?: string;
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
  // entropyBackstop: curated shared memory is prose, never an env dump — so unlike
  // the code/diff scan, here we also refuse a high-entropy `KEY=value` even under
  // an allowlisted env prefix (KIT_/GITHUB_/…), closing the fail-closed-scan hole.
  const found = findSecrets(scanned, { entropyBackstop: true });
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
  // Lifecycle fields are written only when meaningful, so a plain `active` entry
  // stays byte-identical to pre-lifecycle entries (clean diffs, backward-compat).
  if (input.status && input.status !== "active") entry.status = input.status;
  if (input.supersedes) entry.supersedes = input.supersedes;
  if (input.reverses) entry.reverses = input.reverses;
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

/**
 * Effective lifecycle status of an entry given the full set. An explicit
 * `status` field wins; otherwise an entry is `superseded`/`reversed` if a LATER
 * entry points at it (deny-by-default toward "active": only an unreferenced,
 * unmarked entry is active). `reverses` outranks `supersedes` if both reference it.
 * Pure — the surfacing layer decides what to show; kit never auto-decides relevance.
 */
export function effectiveStatus(entry: SharedEntry, all: SharedEntry[]): SharedStatus {
  if (entry.status === "superseded" || entry.status === "reversed") return entry.status;
  let result: SharedStatus = "active";
  for (const e of all) {
    if (e.id === entry.id) continue;
    if (e.reverses === entry.id) return "reversed";
    if (e.supersedes === entry.id) result = "superseded";
  }
  return result;
}

/** The currently-active shared entries (effectiveStatus === "active"). */
export function activeShared(root: string): SharedEntry[] {
  const all = readShared(root);
  return all.filter((e) => effectiveStatus(e, all) === "active");
}

/**
 * Coarse human age of a timestamp ("today" / "5d ago" / "3mo ago" / "2y ago"),
 * or "" if unparseable. Display-only — surfacing shows age so an old decision is
 * flagged for REVIEW, never blind obedience (the relevance call stays human).
 */
export function formatAge(ts: string, now: Date = new Date()): string {
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
