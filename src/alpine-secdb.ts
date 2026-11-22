function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This consumer requires nonempty strings without ASCII controls. Alpine's types only require strings.
function readText(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${location}: expected a nonempty string without ASCII control characters`);
  }
  return value;
}

/**
 * Parse secdb into source packages, fixed versions, and advisory identifiers.
 * Reject the entire feed if any required value is malformed. Allow unknown additive fields.
 * Preserve identifier strings and union duplicates. Omit versions with no identifiers.
 * Version comparison and the meaning of version "0" belong to the caller.
 */
export function parseSecdb(json: unknown): Map<string, Map<string, string[]>> {
  if (!isObject(json) || !Array.isArray(json.packages)) {
    throw new Error("secdb: no packages list");
  }
  const out = new Map<string, Map<string, string[]>>();
  for (const [index, entry] of json.packages.entries()) {
    const location = `secdb: packages[${index}]`;
    if (!isObject(entry) || !isObject(entry.pkg)) {
      throw new Error(`${location}: expected a pkg object`);
    }
    const pkg = entry.pkg;
    const name = readText(pkg.name, `${location}.pkg.name`);
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
    const merged = out.get(name) ?? new Map<string, string[]>();
    for (const [version, ids] of fixes) {
      merged.set(version, [...new Set([...(merged.get(version) ?? []), ...ids])]);
    }
    out.set(name, merged);
  }
  return out;
}
