import { scannerObject, scannerRecord, type ScannerGap } from "./check-scanner-evidence.js";

const PACKAGE = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\dA-Za-z.-]+(?:\+[\dA-Za-z.-]+)*)?$/;
const JSON_STRING = /"(?:\\.|[^"\\])*"/;

function decodeBunLock(text: string): Record<string, unknown> | undefined {
  // Keep strings intact when removing JSONC comments and trailing commas.
  const comments = new RegExp(`${JSON_STRING.source}|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*`, "g");
  const commas = new RegExp(`${JSON_STRING.source}|,(?=\\s*[}\\]])`, "g");
  return scannerObject(
    text
      .replace(comments, (token) => (token.startsWith('"') ? token : " "))
      .replace(commas, (token) => (token === "," ? "" : token)),
  );
}

function packageFromTuple(
  tuple: unknown,
  workspaces: Record<string, unknown>,
): string | true | undefined {
  if (!Array.isArray(tuple) || typeof tuple[0] !== "string") return undefined;
  const at = tuple[0].lastIndexOf("@");
  const name = tuple[0].slice(0, at);
  const source = tuple[0].slice(at + 1);
  if (!PACKAGE.test(name)) return undefined;
  if (source.startsWith("workspace:"))
    return Object.hasOwn(workspaces, source.slice(10)) || undefined;
  if (!VERSION.test(source) || typeof tuple[1] !== "string") return undefined;
  if (tuple[1] !== "" && !tuple[1].startsWith("https://registry.npmjs.org/")) return undefined;
  return name;
}

/** Bun's JSON report hides package resolutions that do not come from an npm registry. */
export function readBunAuditScope(text: string): ReadonlySet<string> | ScannerGap {
  const lock = decodeBunLock(text);
  if (!lock || !scannerRecord(lock.packages) || !scannerRecord(lock.workspaces)) {
    return {
      status: "malformed",
      reason: "Bun lockfile does not contain a package and workspace inventory",
    };
  }
  if (lock.lockfileVersion !== 1) {
    return { status: "unsupported", reason: "Bun audit scope requires a supported text lockfile" };
  }
  const names = new Set<string>();
  for (const value of Object.values(lock.packages)) {
    const name = packageFromTuple(value, lock.workspaces);
    if (name === undefined)
      return {
        status: "unsupported",
        reason: "Bun lockfile contains a resolution outside the verified registry scope",
      };
    if (typeof name === "string") names.add(name);
  }
  return names;
}
