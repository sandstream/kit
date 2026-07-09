/**
 * kit project profile — the versioned, traveling setup declaration (Pillar 4, 5.0).
 *
 * Design: `kit-research/docs/research/pillar4-traveling-profile-5.0.md`.
 *
 * kit's setup-state is today scattered across ≥6 files (`.kit.toml`, `.kit-baseline.json`,
 * `skills-lock.json`, `.mcp.json`/`.claude.json`, `.kit-policy.*`) with nothing binding,
 * versioning, or auditing it as a whole. The profile is a single versioned DECLARATION of
 * `{skills, workflows, MCP, plugins, vault-config, gates, scope}` that TRAVELS with the repo
 * and that kit challenges against reality over time (declared-vs-discovered drift, a later
 * step). It REFERENCES those artifacts; it does not duplicate their contents.
 *
 * This module is the pure floor: the type, its Zod schema, load/save of `.kit-profile.toml`,
 * and a CANONICAL byte form for signing/diffing (recursively key-sorted JSON, `generated`
 * excluded) — the same signing discipline as `.kit-policy.toml` (`canonicalPolicyBytes`).
 * No CLI, no discovery, no drift here (later steps). Zero-LLM, deterministic.
 *
 * WHY A SEPARATE FILE (`.kit-profile.toml`): it is signed and travels as one unit; mixing a
 * signed declaration into the editable `.kit.toml` would blur the signature surface. Same
 * reasoning kit already applies to `.kit-policy.toml`.
 *
 * NO SECRET VALUES live here — only backend *selection* and key *names*; plaintext values
 * remain blocked by the `.env*` write-gate.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

export const PROFILE_FILE = ".kit-profile.toml";
/** Schema version this kit understands. A profile declaring a higher version is refused (upgrade kit). */
export const PROFILE_SCHEMA_VERSION = 1;

/** A declared toolchain component (skill / MCP server / workflow / plugin). */
export interface ProfileComponent {
  /** Unique name/slug within its kind. */
  name: string;
  /** Where it comes from (e.g. `github:org/repo#skill`, `npx @scope/pkg`, a local path). */
  source?: string;
  /** Declared version, if pinned. */
  version?: string;
}

/** Vault/secrets backend DECLARATION — selection only, never values. */
export interface ProfileVault {
  /** Global default store (mirrors `.kit.toml` `secrets.store`). */
  store?: string;
  /** Per-key backend source, keyed by env-var name (mirrors per-key `secrets.<KEY>.source`). */
  keys?: Record<string, string>;
}

/** Which gates the profile declares in force (references, does not inline, the baseline). */
export interface ProfileGates {
  /** Path to the findings baseline this profile expects (default `.kit-baseline.json`). */
  baseline?: string;
  /** Standards gate expected on. */
  standards?: boolean;
  /** Security gate expected on. */
  security?: boolean;
}

/**
 * Signed scope / rules-of-engagement. Feeds Pillar 3's exec-broker SCOPE once signed
 * (`.kit-profile.sig`, a later step). Declaration only here.
 */
export interface ProfileScope {
  /** Egress allowlist (hosts the agent may reach). */
  egress?: string[];
  /** Filesystem write-scope (paths writes are confined to; default project root `.`). */
  fs?: string[];
  /** Secret-scope: env-var names the operation is allowed to see. */
  secrets?: string[];
}

export interface KitProfile {
  /** Schema version (integer). Required. */
  version: number;
  /** ISO timestamp of last freeze. The ONLY non-deterministic field — excluded from canonical bytes. */
  generated: string;
  /** Human label for the profile. */
  name?: string;
  skills?: ProfileComponent[];
  mcp?: ProfileComponent[];
  workflows?: ProfileComponent[];
  plugins?: ProfileComponent[];
  vault?: ProfileVault;
  gates?: ProfileGates;
  scope?: ProfileScope;
}

/**
 * A `.kit-profile.toml` that exists but is unparseable or fails schema validation. Tagged so
 * gate paths can fail CLOSED with a clean message instead of letting a raw TomlError / ZodError
 * crash the process — the same discipline as `InvalidConfigError` for `.kit.toml`.
 */
export class InvalidProfileError extends Error {
  readonly code = "KIT_INVALID_PROFILE";
  constructor(message: string) {
    super(message);
    this.name = "InvalidProfileError";
  }
}

const componentSchema = z
  .object({
    name: z.string().min(1),
    source: z.string().optional(),
    version: z.string().optional(),
  })
  .strict();

const kitProfileSchema = z
  .object({
    version: z.number().int(),
    generated: z.string().optional(),
    name: z.string().optional(),
    skills: z.array(componentSchema).optional(),
    mcp: z.array(componentSchema).optional(),
    workflows: z.array(componentSchema).optional(),
    plugins: z.array(componentSchema).optional(),
    vault: z
      .object({
        store: z.string().optional(),
        keys: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    gates: z
      .object({
        baseline: z.string().optional(),
        standards: z.boolean().optional(),
        security: z.boolean().optional(),
      })
      .strict()
      .optional(),
    scope: z
      .object({
        egress: z.array(z.string()).optional(),
        fs: z.array(z.string()).optional(),
        secrets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively key-sort a value so serialization is stable across key reorder / TOML reformat. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Strict parse of profile file content. Throws `InvalidProfileError` on malformed TOML, a
 * failed schema, or a version this kit is too old to understand. A missing `version` is
 * rejected (a profile without a schema version can't be safely interpreted).
 */
export function parseProfile(raw: string): KitProfile {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new InvalidProfileError(
      `unparseable ${PROFILE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = kitProfileSchema.safeParse(doc);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? ` at ${first.path.join(".")}` : "";
    throw new InvalidProfileError(
      `invalid ${PROFILE_FILE}${where}: ${first?.message ?? "schema error"}`,
    );
  }
  const profile = result.data as KitProfile;
  if (profile.version > PROFILE_SCHEMA_VERSION) {
    throw new InvalidProfileError(
      `${PROFILE_FILE} schema version ${profile.version} is newer than this kit understands (${PROFILE_SCHEMA_VERSION}) — upgrade kit`,
    );
  }
  if (typeof profile.generated !== "string") profile.generated = new Date(0).toISOString();
  return profile;
}

/**
 * Load `.kit-profile.toml`. Returns `null` when no profile is declared (so callers can
 * `skip` honestly rather than treat "no profile" as "empty profile"). Throws
 * `InvalidProfileError` when a profile exists but is malformed.
 */
export async function loadProfile(cwd = process.cwd()): Promise<KitProfile | null> {
  const path = resolve(cwd, PROFILE_FILE);
  if (!(await pathExists(path))) return null;
  const raw = await readFile(path, "utf-8");
  return parseProfile(raw);
}

/**
 * Serialize a profile to TOML with a fresh `generated` stamp and write it. Keys are emitted in
 * a stable (sorted) order so unrelated re-freezes produce minimal diffs. The signed/diffed
 * surface is `canonicalProfileBytes`, not this text.
 */
export async function saveProfile(profile: KitProfile, cwd = process.cwd()): Promise<void> {
  profile.generated = new Date().toISOString();
  const ordered = sortDeep(profile) as Record<string, unknown>;
  const path = resolve(cwd, PROFILE_FILE);
  await writeFile(path, stringify(ordered) + "\n", "utf-8");
}

/**
 * Canonical signing/diffing bytes: JSON of the recursively key-sorted profile with the
 * volatile `generated` stamp removed. Stable across TOML reformatting, comment edits, and key
 * reordering — only a real declaration change moves the bytes (and thus invalidates a
 * `.kit-profile.sig`). Same discipline as `canonicalPolicyBytes`.
 */
export function canonicalProfileBytes(profile: KitProfile): string {
  const { generated: _generated, ...rest } = profile;
  return JSON.stringify(sortDeep(rest));
}

/** Short content fingerprint of a profile (for display / pinning). */
export function profileFingerprint(profile: KitProfile): string {
  return (
    "sha256:" +
    createHash("sha256").update(canonicalProfileBytes(profile)).digest("hex").slice(0, 16)
  );
}
