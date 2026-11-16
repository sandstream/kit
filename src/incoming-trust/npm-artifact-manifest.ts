import { parseNpmObject } from "./npm-json.js";

export type NpmManifestResult =
  | {
      status: "verified";
      name: string;
      version: string;
      scripts: Record<string, string>;
    }
  | { status: "rejected" | "unsupported"; reason: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(
  value: unknown,
): value is Record<string, unknown> & { name: string; version: string } {
  return (
    object(value) &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    typeof value.version === "string" &&
    value.version.trim() !== ""
  );
}

function scripts(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!object(value)) return null;
  const entries: [string, string][] = [];
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== "string") return null;
    entries.push([name, command]);
  }
  return Object.fromEntries(entries);
}

/** Inspect manifest data only. This result grants no execution permission. */
export function inspectNpmManifest(
  bytes: Buffer,
  expected: { name: string; version: string },
): NpmManifestResult {
  if (!Buffer.isBuffer(bytes)) return { status: "rejected", reason: "invalid-manifest-bytes" };
  if (!identity(expected)) return { status: "rejected", reason: "invalid-expected-identity" };
  const parsed = parseNpmObject(bytes, 1024 * 1024);
  if ("issues" in parsed) {
    const reasons = {
      "invalid-utf8": "invalid-manifest-utf8",
      "invalid-json": "invalid-manifest-json",
      "duplicate-json-key": "duplicate-manifest-key",
      "input-limit": "manifest-limit",
      "invalid-schema": "invalid-manifest-schema",
    };
    const code = parsed.issues[0].code;
    return { status: code === "input-limit" ? "unsupported" : "rejected", reason: reasons[code] };
  }
  const manifest = parsed.value;
  if (!identity(manifest)) return { status: "rejected", reason: "invalid-manifest-schema" };
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    return { status: "rejected", reason: "manifest-identity-mismatch" };
  }
  const commands = scripts(manifest.scripts);
  if (commands === null) return { status: "rejected", reason: "invalid-manifest-scripts" };
  return {
    status: "verified",
    name: manifest.name,
    version: manifest.version,
    scripts: commands,
  };
}
