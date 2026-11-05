// Fail the publish job when an SBOM does not list what the package ships.
// The 7.2.0 SBOMs held one component, the root, because syft scanned an unpacked
// tarball that has no node_modules. A file that names no dependency passes every
// format check and tells a consumer nothing, so count the components.
//
// Usage: node scripts/verify-sbom.mjs <cyclonedx.json> <spdx.json> <name> <version> [min]
import { readFileSync } from "node:fs";

export const MIN_COMPONENTS = 10;

/** Names of the packages an SBOM lists, without its root. Null when the format is unknown. */
export function componentNames(doc) {
  if (Array.isArray(doc?.components)) return doc.components.map((c) => String(c?.name ?? ""));
  if (Array.isArray(doc?.packages)) return doc.packages.map((p) => String(p?.name ?? ""));
  if (doc?.bomFormat === "CycloneDX") return [];
  return null;
}

/** Problems found in one SBOM, as plain sentences. An empty list means it passed. */
export function judgeSbom(label, doc, rootName, min = MIN_COMPONENTS) {
  const names = componentNames(doc);
  if (names === null) return [`${label}: not a CycloneDX or SPDX document`];
  const others = names.filter((n) => n !== "" && n !== rootName);
  const found = [];
  if (others.length < min) {
    found.push(`${label}: lists ${others.length} dependencies, expected at least ${min}`);
  }
  return found;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && process.argv[1].endsWith("verify-sbom.mjs")) {
  const [cdx, spdx, name, , min] = process.argv.slice(2);
  if (!cdx || !spdx || !name) {
    console.error("usage: node scripts/verify-sbom.mjs <cyclonedx> <spdx> <name> <version> [min]");
    process.exit(2);
  }
  const limit = min ? Number(min) : MIN_COMPONENTS;
  const found = [
    ...judgeSbom("sbom.cyclonedx.json", readJson(cdx), name, limit),
    ...judgeSbom("sbom.spdx.json", readJson(spdx), name, limit),
  ];
  for (const f of found) console.error(`::error::${f}`);
  if (found.length > 0) process.exit(1);
  console.log("Both SBOMs list the package's dependencies.");
}
