import { parseJsonObject } from "./utils/json-object.js";

export type AlpineRepository = "main" | "community";

export interface SecdbIdentity {
  branch: string;
  repository: AlpineRepository;
}

type Fixes = Map<string, string[]>;
export type Secdb = Map<string, Fixes>;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This consumer requires nonempty strings without control characters. Alpine's types only require strings.
function readText(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${location}: expected a nonempty string without control characters`);
  }
  return value;
}

function addPackage(target: Secdb, name: string, fixes: ReadonlyMap<string, string[]>): void {
  const merged = target.get(name) ?? new Map<string, string[]>();
  for (const [version, ids] of fixes)
    merged.set(version, [...new Set([...(merged.get(version) ?? []), ...ids])]);
  target.set(name, merged);
}

export function mergeSecdb(sources: readonly Secdb[]): Secdb {
  const combined: Secdb = new Map();
  for (const source of sources)
    for (const [name, fixes] of source) addPackage(combined, name, fixes);
  return combined;
}

export function readSecdbSource(
  bytes: Uint8Array,
  identity: SecdbIdentity,
  maxBytes: number,
): Secdb {
  const doc = parseJsonObject(bytes, maxBytes);
  if ("issues" in doc) throw new Error("secdb: " + doc.issues[0].message);
  if (doc.value.distroversion !== identity.branch)
    throw new Error("secdb: missing or mismatched branch");
  if (doc.value.reponame !== identity.repository)
    throw new Error("secdb: missing or mismatched repository");
  return parseSecdb(doc.value);
}

/**
 * Parse secdb into source packages, fixed versions, and advisory identifiers.
 * Reject the entire feed if any required value is malformed. Allow unknown additive fields.
 * Preserve identifier strings and union duplicates. Omit versions with no identifiers.
 * Version comparison and the meaning of version "0" belong to the caller.
 */
export function parseSecdb(json: unknown): Secdb {
  if (!isObject(json) || !Array.isArray(json.packages)) {
    throw new Error("secdb: no packages list");
  }
  const out: Secdb = new Map();
  for (const [index, entry] of json.packages.entries()) {
    const location = `secdb: packages[${index}]`;
    if (!isObject(entry) || !isObject(entry.pkg)) {
      throw new Error(`${location}: expected a pkg object`);
    }
    const pkg = entry.pkg;
    const name = readText(pkg.name, `${location}.pkg.name`);
    if (!PACKAGE_NAME.test(name)) throw new Error(`${location}.pkg.name: invalid package name`);
    if (!isObject(pkg.secfixes)) {
      throw new Error(`${location}.pkg.secfixes: expected an object`);
    }
    const fixes = new Map<string, string[]>();
    for (const [version, ids] of Object.entries(pkg.secfixes)) {
      readText(version, `${location}.pkg.secfixes version`);
      if (!Array.isArray(ids)) {
        throw new Error(`${location}.pkg.secfixes: expected an identifier array`);
      }
      const identifiers: string[] = [];
      for (const id of ids) {
        identifiers.push(readText(id, `${location}.pkg.secfixes identifier`));
      }
      if (identifiers.length > 0) fixes.set(version, identifiers);
    }
    addPackage(out, name, fixes);
  }
  return out;
}
