/**
 * GuardDog 3.2 reads an npm archive's package.json from `package/`, or from a folder named after the
 * unscoped package name. Some archives use another root folder: `@types/node` 22.x ships
 * `node v22.20/`. GuardDog's metadata_mismatch rule then fails to run, the package stays
 * unverified and the scan cannot pass, although nothing was found.
 *
 * For such a package kit runs that one rule again on a normalised copy. It fetches the exact
 * version's registry document and tarball from registry.npmjs.org, checks the tarball against the
 * document's integrity, takes the archive's package.json, writes it under `package/` in a new
 * temporary directory and runs `guarddog npm scan <dir> --rules metadata_mismatch --metadata
 * <document>`. GuardDog's source rules already read the files under the other root folder.
 *
 * Fail closed: when any step fails, the report keeps GuardDog's error and the package still counts
 * as unverified. A finding from the rerun counts like any other metadata finding.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { scannerRecord } from "./check-scanner-evidence.js";
import {
  fetchNpmTarball,
  type NpmArtifactFetchPolicy,
  type NpmArtifactFetchResult,
} from "./incoming-trust/npm-artifact-fetch.js";
import { verifyNpmIntegrity } from "./incoming-trust/npm-artifact-integrity.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import { parseJsonObject } from "./utils/json-object.js";

const RULE = "metadata_mismatch";
const ROOT_ERROR =
  /^failed to run rule metadata_mismatch: package\.json was not found at an expected npm archive root: /;
const REGISTRY = "https://registry.npmjs.org";
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_FETCH_MS = 20_000;
const MAX_TAR_BYTES = 64 * 1024 * 1024;
/** A bound on the extra downloads and scans one check can start. */
const MAX_RESCANS = 8;
// The name and version go into a registry URL, so only plain npm spellings are accepted.
const NPM_NAME = /^(?:@[a-z\d_~][a-z\d._~-]*\/)?[a-z\d_~][a-z\d._~-]*$/i;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

/** Network and process access, replaceable in tests. */
export interface ArchiveRootTools {
  fetch: (url: string, policy: NpmArtifactFetchPolicy) => Promise<NpmArtifactFetchResult>;
  exec: typeof execFileNoThrow;
}

const DEFAULT_TOOLS: ArchiveRootTools = { fetch: fetchNpmTarball, exec: execFileNoThrow };

interface RootErrorRow {
  dependency: string;
  version: string;
  result: Record<string, unknown> & { issues: number; errors: Record<string, unknown> };
}

interface Rescan {
  bin: string;
  timeoutMs: number;
  tools: ArchiveRootTools;
}

/** A report row whose only problem kit can repair is the archive root error. */
function rootErrorRow(entry: unknown): entry is RootErrorRow {
  if (!scannerRecord(entry) || !scannerRecord(entry.result)) return false;
  const { dependency, version, result } = entry;
  const { errors, issues, results } = result;
  return (
    typeof dependency === "string" &&
    NPM_NAME.test(dependency) &&
    typeof version === "string" &&
    NPM_VERSION.test(version) &&
    Number.isSafeInteger(issues) &&
    (results === undefined || scannerRecord(results)) &&
    scannerRecord(errors) &&
    typeof errors[RULE] === "string" &&
    ROOT_ERROR.test(errors[RULE])
  );
}

function reportEntries(stdout: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function policy(rescan: Rescan, maxBytes?: number): NpmArtifactFetchPolicy {
  const timeoutMs = Math.min(Math.max(1, rescan.timeoutMs), MAX_FETCH_MS);
  return maxBytes
    ? { origins: [REGISTRY], timeoutMs, maxBytes }
    : { origins: [REGISTRY], timeoutMs };
}

/** The registry document of one exact version, as GuardDog reads it from the full packument. */
async function registryDocument(row: RootErrorRow, rescan: Rescan) {
  const url = `${REGISTRY}/${row.dependency.replaceAll("/", "%2F")}/${row.version}`;
  const fetched = await rescan.tools.fetch(url, policy(rescan, MAX_DOCUMENT_BYTES));
  if (fetched.status !== "retrieved") return undefined;
  const parsed = parseJsonObject(fetched.bytes, MAX_DOCUMENT_BYTES);
  if ("issues" in parsed) return undefined;
  const doc = parsed.value;
  const dist = doc.dist;
  if (doc.name !== row.dependency || doc.version !== row.version || !scannerRecord(dist)) {
    return undefined;
  }
  const { tarball, integrity } = dist;
  if (typeof tarball !== "string" || typeof integrity !== "string") return undefined;
  return { doc, tarball, integrity };
}

interface TarEntry {
  path: string;
  type: string;
  body: Buffer;
  next: number;
}

function tarText(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** One tar entry at `offset`, or undefined at the end marker or on a damaged header. */
function tarEntry(tar: Buffer, offset: number, longPath?: string): TarEntry | undefined {
  const header = tar.subarray(offset, offset + 512);
  if (header.length < 512 || header.every((byte) => byte === 0)) return undefined;
  const size = Number.parseInt(tarText(header.subarray(124, 136)).trim() || "0", 8);
  const body = tar.subarray(offset + 512, offset + 512 + size);
  if (!Number.isSafeInteger(size) || size < 0 || body.length !== size) return undefined;
  const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? tarText(header.subarray(345, 500)) : "";
  const name = tarText(header.subarray(0, 100));
  const path = longPath ?? (prefix ? `${prefix}/${name}` : name);
  const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
  return { path, type, body, next: offset + 512 + Math.ceil(size / 512) * 512 };
}

/** The path a pax or GNU long-name entry gives the entry after it. */
function longName(entry: TarEntry): string | undefined {
  if (entry.type === "L") return tarText(entry.body);
  return /(?:^|\n)\d+ path=([^\n]*)\n/.exec(entry.body.toString("utf8"))?.[1];
}

/**
 * The single root folder of an npm tarball and its package.json. kit reads only that one file
 * and writes no path taken from the archive, so this reader stays smaller than a full extractor.
 */
function tarballManifest(gzipped: Buffer): { root: string; manifest: Buffer } | undefined {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    return undefined;
  }
  const roots = new Set<string>();
  const manifests: TarEntry[] = [];
  let pending: string | undefined;
  for (let entry = tarEntry(tar, 0); entry; entry = tarEntry(tar, entry.next, pending)) {
    if (["x", "L", "g"].includes(entry.type)) {
      pending = entry.type === "g" ? pending : longName(entry);
      continue;
    }
    pending = undefined;
    const parts = entry.path.replace(/^\.\//, "").split("/");
    roots.add(parts[0]);
    if (parts.length === 2 && parts[1] === "package.json") manifests.push(entry);
  }
  const [manifest] = manifests;
  if (roots.size !== 1 || manifests.length !== 1 || manifest.type !== "0") return undefined;
  return { root: [...roots][0], manifest: Buffer.from(manifest.body) };
}

/** package.json of the verified tarball, only when its root folder is one GuardDog cannot read. */
async function archiveManifest(
  row: RootErrorRow,
  found: { tarball: string; integrity: string },
  rescan: Rescan,
): Promise<Buffer | undefined> {
  const fetched = await rescan.tools.fetch(found.tarball, policy(rescan));
  if (fetched.status !== "retrieved") return undefined;
  if (verifyNpmIntegrity(fetched.bytes, found.integrity).status !== "verified") return undefined;
  const read = tarballManifest(fetched.bytes);
  const { dependency: name, version } = row;
  if (!read || read.root === "package" || read.root === name.split("/").pop()) return undefined;
  const parsed = parseJsonObject(read.manifest, MAX_DOCUMENT_BYTES);
  if ("issues" in parsed || parsed.value.name !== name || parsed.value.version !== version) {
    return undefined;
  }
  return read.manifest;
}

/** The rule's own result: null when it found nothing, its text when it fired. */
function ruleOutcome(stdout: string): string | null | undefined {
  const parsed = parseJsonObject(Buffer.from(stdout), MAX_DOCUMENT_BYTES);
  if ("issues" in parsed) return undefined;
  const { errors, results, issues } = parsed.value;
  if (!scannerRecord(errors) || Object.keys(errors).length > 0 || !scannerRecord(results)) {
    return undefined;
  }
  const value = results[RULE];
  if (value === null && issues === 0) return null;
  return typeof value === "string" && value !== "" && issues === 1 ? value : undefined;
}

async function scanManifest(
  row: RootErrorRow,
  doc: Record<string, unknown>,
  manifest: Buffer,
  rescan: Rescan,
): Promise<string | null | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "kit-guarddog-root-"));
  try {
    const archive = join(dir, "archive");
    mkdirSync(join(archive, "package"), { recursive: true });
    writeFileSync(join(archive, "package", "package.json"), manifest);
    // GuardDog takes the name and version from the top level and compares versions[version].
    const metadata = join(dir, "metadata.json");
    const { dependency: name, version } = row;
    writeFileSync(metadata, JSON.stringify({ name, version, versions: { [version]: doc } }));
    const args = ["npm", "scan", archive, "--rules", RULE, "--metadata", metadata];
    const result = await rescan.tools.exec(rescan.bin, [...args, "--output-format=json"], {
      timeout: rescan.timeoutMs,
      cwd: dir,
    });
    return result.ok ? ruleOutcome(result.stdout) : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rescanRow(row: RootErrorRow, rescan: Rescan): Promise<boolean> {
  const found = await registryDocument(row, rescan);
  if (!found) return false;
  const manifest = await archiveManifest(row, found, rescan);
  if (!manifest) return false;
  const outcome = await scanManifest(row, found.doc, manifest, rescan);
  if (outcome === undefined) return false;
  delete row.result.errors[RULE];
  row.result.results = { ...(row.result.results as Record<string, unknown>), [RULE]: outcome };
  if (outcome !== null) row.result.issues += 1;
  return true;
}

/**
 * Rerun metadata_mismatch for npm packages whose archive root GuardDog could not read, and put the
 * outcome in the verify report. Rows kit cannot repair keep GuardDog's error.
 */
export async function rescanArchiveRoots(
  ecosystem: "npm" | "pypi",
  result: ExecResult,
  bin: string,
  timeoutMs: number,
  tools: ArchiveRootTools = DEFAULT_TOOLS,
): Promise<ExecResult> {
  const entries = ecosystem === "npm" ? reportEntries(result.stdout) : undefined;
  const rows = (entries ?? []).filter(rootErrorRow).slice(0, MAX_RESCANS);
  let repaired = false;
  for (const row of rows) {
    if (await rescanRow(row, { bin, timeoutMs, tools })) repaired = true;
  }
  return repaired ? { ...result, stdout: JSON.stringify(entries) } : result;
}
