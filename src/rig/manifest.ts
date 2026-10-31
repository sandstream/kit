/**
 * The rig's frozen input (ADR-0007): a manifest that names the commit under review, the
 * reviewer prompt or policy being tested, the planted defects and the clean controls.
 *
 *   [input]
 *   repo = "acme/webapp"
 *   commit = "<full sha>"
 *   prompt = "prompts/review.md"
 *   tolerance = 3            # lines, default 3
 *
 *   [[defect]]
 *   id = "d1"
 *   file = "src/auth.ts"
 *   line_start = 40
 *   line_end = 42
 *   kind = "missing-check"
 *   split = "tune"           # or "holdout"; required
 *   patch = "defects/d1.diff"
 *
 *   [[control]]
 *   id = "c1"
 *   patch = "controls/c1.diff"
 *
 * The manifest usually lives outside this public repository (a corpus must never be
 * published as a benchmark), so it is untrusted input: unknown keys are refused, every
 * referenced path must stay inside the manifest's folder, and nothing is executed.
 *
 * The input id is a SHA-256 over the canonical manifest plus the bytes of the prompt and
 * every patch, with line endings normalised. Two runs with the same id answered the same
 * question.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

export type Split = "tune" | "holdout";

export interface RigDefect {
  id: string;
  file: string;
  line_start: number;
  line_end: number;
  kind: string;
  split: Split;
  patch: string;
}

export interface RigControl {
  id: string;
  patch: string;
}

export interface RigManifest {
  input: { repo: string; commit: string; prompt: string; tolerance: number };
  defects: RigDefect[];
  controls: RigControl[];
}

export class RigManifestError extends Error {}

export const DEFAULT_TOLERANCE = 3;

const TOP_KEYS = new Set(["input", "defect", "control"]);
const INPUT_KEYS = new Set(["repo", "commit", "prompt", "tolerance"]);
const DEFECT_KEYS = new Set(["id", "file", "line_start", "line_end", "kind", "split", "patch"]);
const CONTROL_KEYS = new Set(["id", "patch"]);

function fail(msg: string): never {
  throw new RigManifestError(msg);
}

function table(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${where} must be a table`);
  return v as Record<string, unknown>;
}

function onlyKeys(t: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const extra = Object.keys(t).filter((k) => !allowed.has(k));
  if (extra.length > 0) fail(`${where}: unknown key(s) ${extra.sort().join(", ")}`);
}

function str(t: Record<string, unknown>, key: string, where: string): string {
  const v = t[key];
  if (typeof v !== "string" || v.trim() === "")
    fail(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function posInt(t: Record<string, unknown>, key: string, where: string): number {
  const v = t[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    fail(`${where}: "${key}" must be a positive integer`);
  }
  return v;
}

/**
 * A repository-relative path written with `/`: no absolute path, no `..`, no backslash
 * surprises. Used for both the defect's `file` and every patch/prompt path.
 */
export function relPath(raw: string, where: string): string {
  const slashed = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || isAbsolute(raw)) {
    fail(`${where}: "${raw}" must be relative`);
  }
  if (slashed.split("/").some((part) => part === ".."))
    fail(`${where}: "${raw}" must not contain ..`);
  return slashed;
}

function parseInput(v: unknown): RigManifest["input"] {
  const t = table(v, "[input]");
  onlyKeys(t, INPUT_KEYS, "[input]");
  const commit = str(t, "commit", "[input]");
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    fail(`[input]: "commit" must be a full 40- or 64-character lowercase hex SHA`);
  }
  let tolerance = DEFAULT_TOLERANCE;
  if (t.tolerance !== undefined) {
    if (typeof t.tolerance !== "number" || !Number.isInteger(t.tolerance) || t.tolerance < 0) {
      fail(`[input]: "tolerance" must be a non-negative integer`);
    }
    tolerance = t.tolerance;
  }
  return {
    repo: str(t, "repo", "[input]"),
    commit,
    prompt: relPath(str(t, "prompt", "[input]"), "[input] prompt"),
    tolerance,
  };
}

function parseDefect(v: unknown, i: number): RigDefect {
  const where = `[[defect]] #${i + 1}`;
  const t = table(v, where);
  onlyKeys(t, DEFECT_KEYS, where);
  if (t.split === undefined) fail(`${where}: "split" is required ("tune" or "holdout")`);
  if (t.split !== "tune" && t.split !== "holdout")
    fail(`${where}: "split" must be "tune" or "holdout"`);
  const lineStart = posInt(t, "line_start", where);
  const lineEnd = posInt(t, "line_end", where);
  if (lineEnd < lineStart) fail(`${where}: "line_end" is before "line_start"`);
  return {
    id: str(t, "id", where),
    file: relPath(str(t, "file", where), `${where} file`),
    line_start: lineStart,
    line_end: lineEnd,
    kind: str(t, "kind", where),
    split: t.split,
    patch: relPath(str(t, "patch", where), `${where} patch`),
  };
}

function parseControl(v: unknown, i: number): RigControl {
  const where = `[[control]] #${i + 1}`;
  const t = table(v, where);
  onlyKeys(t, CONTROL_KEYS, where);
  return { id: str(t, "id", where), patch: relPath(str(t, "patch", where), `${where} patch`) };
}

function list(v: unknown, where: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${where} must be an array of tables`);
  return v;
}

/** Parse and validate a `rig.toml`. Throws `RigManifestError` with a fixed, located message. */
export function parseManifest(text: string): RigManifest {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    fail("rig.toml is not valid TOML");
  }
  onlyKeys(doc, TOP_KEYS, "rig.toml");
  const manifest: RigManifest = {
    input: parseInput(doc.input),
    defects: list(doc.defect, "[[defect]]").map(parseDefect),
    controls: list(doc.control, "[[control]]").map(parseControl),
  };
  const ids = [...manifest.defects, ...manifest.controls].map((d) => d.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) fail(`duplicate id "${dup}" across [[defect]] and [[control]]`);
  if (manifest.defects.length === 0) fail("rig.toml declares no [[defect]]");
  return manifest;
}

/** JSON with object keys sorted at every level: the same manifest always serialises the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Every file the manifest references, relative to its folder, sorted and de-duplicated. */
export function referencedFiles(m: RigManifest): string[] {
  const all = [m.input.prompt, ...m.defects.map((d) => d.patch), ...m.controls.map((c) => c.patch)];
  return [...new Set(all)].sort();
}

/**
 * The input id over a parsed manifest and the contents of its referenced files (keyed by the
 * manifest's relative path). Line endings are normalised, so a checkout with `\r\n` hashes
 * the same as one with `\n`.
 */
export function inputId(m: RigManifest, files: Record<string, string>): string {
  const h = createHash("sha256");
  h.update("kit-rig-input-v1\0");
  h.update(canonicalJson(m));
  for (const path of referencedFiles(m)) {
    const body = files[path];
    if (body === undefined) fail(`referenced file "${path}" was not supplied`);
    h.update(`\0${path}\0`);
    h.update(body.replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
}

/** Resolve a manifest-relative path to a file inside the manifest's folder. */
function inside(manifestPath: string, rel: string): string {
  const base = normalize(dirname(manifestPath));
  const full = normalize(join(base, ...rel.split("/")));
  if (full !== base && !full.startsWith(base.endsWith(sep) ? base : base + sep)) {
    fail(`"${rel}" resolves outside the manifest's folder`);
  }
  return full;
}

/** Read a `rig.toml` from disk, validate it, read every referenced file and compute the input id. */
export async function loadManifest(
  manifestPath: string,
): Promise<{ manifest: RigManifest; inputId: string; files: Record<string, string> }> {
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const files: Record<string, string> = {};
  for (const rel of referencedFiles(manifest)) {
    try {
      files[rel] = await readFile(inside(manifestPath, rel), "utf8");
    } catch (err) {
      if (err instanceof RigManifestError) throw err;
      fail(`referenced file "${rel}" could not be read`);
    }
  }
  return { manifest, inputId: inputId(manifest, files), files };
}
