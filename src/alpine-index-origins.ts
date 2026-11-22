const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

function addOrigin(origins: Map<string, string>, name: string, origin: string): void {
  const previous = origins.get(name);
  // Different versions can have different sources. Ambiguity stays local to this package.
  origins.set(name, previous !== undefined && previous !== origin ? "" : origin);
}

function projectRecord(lines: readonly string[]): [string, string] {
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (line.length < 2 || line[1] !== ":" || /[\u0000-\u001f\u007f-\u009f]/.test(line)) {
      throw new Error(
        "APKINDEX: expected a field key, colon, and value without control characters",
      );
    }
    const key = line[0];
    if (key !== "P" && key !== "V" && key !== "o") continue;
    if (fields.has(key)) throw new Error(`APKINDEX: repeated ${key} field`);
    fields.set(key, line.slice(2));
  }
  const name = fields.get("P");
  if (!name || !fields.get("V")) {
    throw new Error("APKINDEX: each record requires nonempty P and V fields");
  }
  const origin = fields.get("o") ?? "";
  if (!PACKAGE_NAME.test(name) || (origin !== "" && !PACKAGE_NAME.test(origin))) {
    throw new Error("APKINDEX: invalid package or origin name");
  }
  return [name, origin];
}

/**
 * Validate every record for origin projection, not full APK installability.
 * Require P and V once, and o at most once. Unknown metadata needs a valid line shape.
 * Reject control characters and repeated scalar fields as consumer restrictions.
 * Permit empty text or LF-only text. Every nonempty index must end with LF.
 * An empty source name means unknown or ambiguous origin. Do not infer self-origin.
 */
export function parseApkIndexOrigins(text: string): Map<string, string> {
  if (text !== "" && !text.endsWith("\n")) {
    throw new Error("APKINDEX: nonempty text must end with LF");
  }
  const origins = new Map<string, string>();
  let record: string[] = [];
  for (const line of text.split("\n")) {
    if (line !== "") {
      record.push(line);
    } else if (record.length > 0) {
      const [name, origin] = projectRecord(record);
      addOrigin(origins, name, origin);
      record = [];
    }
  }
  return origins;
}

/**
 * Merge repository projections. Unknown and conflicting origins remain unresolved per package.
 * Once unresolved, a package cannot acquire a known origin from a later record or merge.
 * Callers must treat each requested unresolved package as unverified coverage.
 */
export function mergeApkIndexOrigins(
  indexes: readonly ReadonlyMap<string, string>[],
): Map<string, string> {
  const origins = new Map<string, string>();
  for (const index of indexes) {
    for (const [name, origin] of index) addOrigin(origins, name, origin);
  }
  return origins;
}
