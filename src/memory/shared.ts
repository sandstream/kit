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
import { identityId, verifySignature, localPublicKeys } from "../identity.js";
import { resolveKeyStore, assertHardwareIdentity, hardwareRequired } from "../keystore/index.js";
import { policySignersMap, hasPolicyAnchor } from "../policy-trust.js";

export type SharedKind =
  | "decision"
  | "convention"
  | "how-built"
  | "status"
  | "security"
  | "note"
  // Negative-space kinds — the knowledge that evaporates hardest:
  | "idea" // considered / not-yet-built
  | "abandoned"; // tried and dropped, with the reason (re-introducing it should warn)

/** All known kinds — for CLI validation so a typo doesn't persist a garbage kind. */
export const SHARED_KINDS: readonly SharedKind[] = [
  "decision",
  "convention",
  "how-built",
  "status",
  "security",
  "note",
  "idea",
  "abandoned",
];

/**
 * Origin of a curated entry — lets recall prefer an operator's explicit statement over a
 * pattern kit merely derived. `operator` = a human stated it (the default when absent, since
 * a human promoted the entry); `derived` = kit inferred it (e.g. `memory learn` repetition);
 * `inferred` = a weaker guess. Ranking: operator > derived > inferred.
 */
export type SharedProvenance = "operator" | "derived" | "inferred";

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
  /** Origin of the entry; absent ⇒ `operator` (a human promoted it). */
  provenance?: SharedProvenance;
  /** Optional operator-supplied confidence; display + tiebreak only, never a gate. */
  confidence?: "low" | "medium" | "high";
  /** Ed25519 signer id (kid) — set when the entry was signed on write. */
  kid?: string;
  /** Base64 Ed25519 signature over the canonical content (excludes kid/sig itself). */
  sig?: string;
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
  provenance?: SharedProvenance;
  confidence?: "low" | "medium" | "high";
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

/**
 * Canonical bytes that a signature covers — every semantic field EXCEPT `kid`/`sig`
 * (the signature can't cover itself). Reconstructed in a FIXED key order so it is
 * independent of on-disk field order and of how the object was parsed: read →
 * re-canonicalize → verify is byte-stable. Optional fields are included only when
 * present, matching how `shareEntry` writes them (so an unsigned legacy entry, if
 * later signed, canonicalizes identically). Pure.
 */
export function sharedEntryCanonical(entry: SharedEntry): string {
  const canon: Record<string, unknown> = {
    id: entry.id,
    area: entry.area,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    refs: entry.refs,
    author: entry.author,
    ts: entry.ts,
  };
  if (entry.source_ref !== undefined) canon.source_ref = entry.source_ref;
  if (entry.status !== undefined) canon.status = entry.status;
  if (entry.supersedes !== undefined) canon.supersedes = entry.supersedes;
  if (entry.reverses !== undefined) canon.reverses = entry.reverses;
  // Appended last + only-when-present so legacy entries canonicalize byte-identically
  // (an unsigned pre-provenance entry, if later signed, is unchanged).
  if (entry.provenance !== undefined) canon.provenance = entry.provenance;
  if (entry.confidence !== undefined) canon.confidence = entry.confidence;
  return JSON.stringify(canon);
}

/**
 * Verdict for one shared entry against a kid → public-key trust store:
 *  - `trusted`          signer is in the store AND the signature verifies;
 *  - `bad-sig`          signer is known but the signature does NOT verify (tamper);
 *  - `untrusted-signer` entry is signed but the signer is not in the trust store;
 *  - `unsigned`         no signature at all (legacy / signed by no-identity machine).
 */
export type SharedVerdict = "trusted" | "bad-sig" | "untrusted-signer" | "unsigned";

/** Classify one entry against a kid → PEM trust store. Pure, never throws. */
export function verifySharedEntry(entry: SharedEntry, signers: Map<string, string>): SharedVerdict {
  if (!entry.kid || !entry.sig) return "unsigned";
  const pem = signers.get(entry.kid);
  if (!pem) return "untrusted-signer";
  const ok = verifySignature(sharedEntryCanonical(entry), Buffer.from(entry.sig, "base64"), pem);
  return ok ? "trusted" : "bad-sig";
}

export interface SharedTierVerification {
  /** True when a committed `.kit-policy.signers` anchor is present ⇒ fail-closed. */
  anchored: boolean;
  total: number;
  results: { entry: SharedEntry; verdict: SharedVerdict }[];
  counts: Record<SharedVerdict, number>;
}

/**
 * Verify every entry in the shared tier. Trust store mirrors the policy discipline:
 * when a committed `.kit-policy.signers` anchor is present, ONLY those org keys are
 * trusted (an un-anchored signer → `untrusted-signer`, fail-closed under --strict);
 * with no anchor, the machine's own identity keys resolve, giving self-integrity
 * (tamper → `bad-sig`) without ceremony. `identityDir` is injectable for tests.
 */
export function verifySharedTier(root: string, identityDir?: string): SharedTierVerification {
  const anchored = hasPolicyAnchor(root);
  const signers = anchored ? policySignersMap(root) : localPublicKeys(identityDir);
  const entries = readShared(root);
  const counts: Record<SharedVerdict, number> = {
    trusted: 0,
    "bad-sig": 0,
    "untrusted-signer": 0,
    unsigned: 0,
  };
  const results = entries.map((entry) => {
    const verdict = verifySharedEntry(entry, signers);
    counts[verdict]++;
    return { entry, verdict };
  });
  return { anchored, total: entries.length, results, counts };
}

/**
 * Filter shared entries down to those SAFE to AUTO-INJECT into a prompt (SessionStart
 * recovery / touched-decisions notice). Closes the gap where a curated team entry was
 * replayed as trusted "Curated team decisions" with no signature check:
 *   - a `bad-sig` (content changed after signing by a key we HOLD) is ALWAYS dropped —
 *     tamper must never be replayed, in any mode;
 *   - when a committed `.kit-policy.signers` anchor is present (the org opted into
 *     signing), ONLY org-`trusted` entries are injected — unsigned / unknown-signer
 *     entries are not trusted team decisions;
 *   - with NO anchor, everything but tamper is kept (org trust can't be established
 *     without an anchor, so we don't break the common team-without-anchor case).
 * Pure; `identityDir` injectable for tests.
 */
export function recallSafeShared(
  root: string,
  entries: SharedEntry[],
  identityDir?: string,
): SharedEntry[] {
  const anchored = hasPolicyAnchor(root);
  const signers = anchored ? policySignersMap(root) : localPublicKeys(identityDir);
  return entries.filter((e) => {
    const verdict = verifySharedEntry(e, signers);
    if (verdict === "bad-sig") return false; // tamper against a known key — never inject
    if (anchored && verdict !== "trusted") return false; // org anchor ⇒ only org-trusted
    return true;
  });
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
  // Provenance/confidence are written only when explicitly provided, so an operator-stated
  // entry (the common case) stays byte-identical to pre-provenance entries; absent ⇒ operator.
  if (input.provenance) entry.provenance = input.provenance;
  if (input.confidence) entry.confidence = input.confidence;
  // Sign on write via the ACTIVE keystore (hardware/externally-held when configured, else
  // the file identity) when one exists — attributable provenance a reviewer/colleague can
  // verify offline with just the public key. No identity ⇒ unsigned entry (backward-
  // compatible) — we never AUTO-CREATE a key as a side-effect of sharing a note.
  // Best-effort + fail-closed: under a hardware mandate with only the file key,
  // assertHardwareIdentity throws → the entry is left UNSIGNED rather than signed with a
  // mandate-violating file key.
  try {
    const res = resolveKeyStore();
    const pub = res.store.publicKeyPem();
    if (pub) {
      assertHardwareIdentity(res, hardwareRequired(root));
      entry.kid = identityId(pub);
      entry.sig = res.store.sign(sharedEntryCanonical(entry)).toString("base64");
    }
  } catch {
    delete entry.kid; // no key / mandate unmet / signer error → leave the entry unsigned
  }
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

/**
 * Recall priority by origin (lower = surfaced first): an operator's explicit statement
 * outranks something kit derived, which outranks a weak inference. Absent provenance ⇒
 * `operator` (a human promoted the entry). Pure — surfacing sorts by this, then recency.
 */
export function provenanceRank(entry: SharedEntry): number {
  switch (entry.provenance ?? "operator") {
    case "operator":
      return 0;
    case "derived":
      return 1;
    case "inferred":
      return 2;
  }
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
