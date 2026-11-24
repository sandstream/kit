import { exactNpmVersion } from "./npm-artifact.js";
import { packageName } from "./npm-lock-read.js";
import { relativePath } from "./npm-lock-workspaces.js";

export interface ExpectedNpmArtifact {
  packagePath: string;
  name: string;
  version: string;
  sha256: string;
}

function expectedArtifact(value: unknown): value is ExpectedNpmArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "name,packagePath,sha256,version") return false;
  const row = value as Partial<ExpectedNpmArtifact>;
  return (
    typeof row.packagePath === "string" &&
    relativePath(row.packagePath) &&
    typeof row.name === "string" &&
    packageName(row.name) &&
    typeof row.version === "string" &&
    exactNpmVersion(row.version) &&
    typeof row.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.sha256)
  );
}

/** Normalize the independent expectations supplied to the authoritative run policy. */
export function parseExpectedNpmArtifacts(value: unknown): ExpectedNpmArtifact[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000 || !value.every(expectedArtifact))
    return undefined;
  if (new Set(value.map(({ packagePath }) => packagePath)).size !== value.length) return undefined;
  return value
    .map(({ packagePath, name, version, sha256 }) => ({ packagePath, name, version, sha256 }))
    .sort((a, b) => (a.packagePath < b.packagePath ? -1 : a.packagePath > b.packagePath ? 1 : 0));
}
