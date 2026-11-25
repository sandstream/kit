// Fail the publish job when an SBOM does not list what the package ships.
// The 7.2.0 SBOMs held one component, the root, because syft scanned an unpacked
// tarball that has no node_modules. A file that names no dependency passes every
// format check and tells a consumer nothing.
//
// The check names the runtime dependencies package.json declares and requires each
// one in each SBOM. It used to require at least 10 components; 7.6.0 has two runtime
// dependencies, so a complete SBOM failed that count and the SBOMs were never attached.
//
// Usage: node scripts/verify-sbom.mjs <cyclonedx.json> <spdx.json> <name> <version> [package.json]
import { readFileSync } from "node:fs";

/** Names of the packages an SBOM lists, without its root. Null when the format is unknown. */
export function componentNames(doc) {
  if (Array.isArray(doc?.components)) return doc.components.map((c) => String(c?.name ?? ""));
  if (Array.isArray(doc?.packages)) return doc.packages.map((p) => String(p?.name ?? ""));
  if (doc?.bomFormat === "CycloneDX") return [];
  return null;
}

/** The runtime dependency names a package.json declares. */
export function runtimeDependencies(pkg) {
  return Object.keys(pkg?.dependencies ?? {});
}

/** Problems found in one SBOM, as plain sentences. An empty list means it passed. */
export function judgeSbom(label, doc, rootName, required) {
  const names = componentNames(doc);
  if (names === null) return [`${label}: not a CycloneDX or SPDX document`];
  if (!Array.isArray(required) || required.length === 0) {
    return [`${label}: no runtime dependencies to check against, so the SBOM proves nothing`];
  }
  const listed = new Set(names.filter((n) => n !== "" && n !== rootName));
  const missing = required.filter((n) => !listed.has(n));
  if (missing.length === 0) return [];
  const noun = missing.length === 1 ? "a runtime dependency" : "runtime dependencies";
  return [`${label}: does not list ${missing.join(", ")}, ${noun}`];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && process.argv[1].endsWith("verify-sbom.mjs")) {
  const [cdx, spdx, name, , pkgPath = "package.json"] = process.argv.slice(2);
  if (!cdx || !spdx || !name) {
    console.error(
      "usage: node scripts/verify-sbom.mjs <cyclonedx> <spdx> <name> <version> [package.json]",
    );
    process.exit(2);
  }
  const required = runtimeDependencies(readJson(pkgPath));
  const found = [
    ...judgeSbom("sbom.cyclonedx.json", readJson(cdx), name, required),
    ...judgeSbom("sbom.spdx.json", readJson(spdx), name, required),
  ];
  for (const f of found) console.error(`::error::${f}`);
  if (found.length > 0) process.exit(1);
  console.log(`Both SBOMs list every runtime dependency: ${required.join(", ")}.`);
}
