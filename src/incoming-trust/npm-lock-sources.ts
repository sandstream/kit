import { Buffer } from "node:buffer";
import type { NpmArtifact, NpmPackage } from "./npm-lock.js";
import { issue, pointer, type Reader, type JsonRecord } from "./npm-lock-read.js";

function source(resolved: string | null): NpmArtifact["source"] {
  if (!resolved || /[\s\\]/.test(resolved)) return "unknown";
  if (/^(git\+|git:|ssh:|git@)/.test(resolved)) return "git";
  if (resolved.startsWith("file:"))
    return /\.(tgz|tar\.gz)$/.test(resolved) ? "local-tarball" : "local-directory";
  try {
    const url = new URL(resolved);
    if (!/^https?:\/\//.test(resolved)) return "unknown";
    return url.hostname === "registry.npmjs.org" ? "registry-tarball" : "remote-tarball";
  } catch {
    return "unknown";
  }
}

function validDigest(token: string): boolean {
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
  if (!match) return false;
  const sizes: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const decoded = Buffer.from(match[2], "base64");
  const canonical = decoded.toString("base64");
  if (match[2].includes("=") && match[2] !== canonical) return false;
  return (
    decoded.length === sizes[match[1]] &&
    decoded.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "")
  );
}

export function artifact(pkg: NpmPackage, raw: JsonRecord, reader: Reader): void {
  const kind = raw.inBundle === true ? "bundled" : source(pkg.resolved);
  reader.result.artifacts.push({
    packagePath: pkg.path,
    name: pkg.name,
    version: pkg.version,
    source: kind,
    resolved: pkg.resolved,
    integrity: pkg.integrity,
  });
  const at = `/packages/${pointer(pkg.path)}`;
  if (!pkg.name || !pkg.version) {
    issue(
      reader,
      "missing-package-identity",
      at,
      "Artifact identity needs a package name and version.",
    );
  }
  if (kind === "unknown") {
    issue(
      reader,
      "unknown-source",
      `${at}/resolved`,
      "Artifact source cannot be classified from the supplied data.",
    );
  } else if (!["registry-tarball", "remote-tarball"].includes(kind)) {
    issue(
      reader,
      "unsupported-source",
      `${at}/resolved`,
      "This source needs additional inventory support before verification.",
    );
  }
  if (["registry-tarball", "remote-tarball", "local-tarball"].includes(kind) && !pkg.integrity) {
    issue(
      reader,
      "missing-integrity",
      `${at}/integrity`,
      "Fetched artifacts require a recorded integrity value.",
    );
  }
  if (pkg.integrity && !pkg.integrity.trim().split(/\s+/).every(validDigest)) {
    issue(
      reader,
      "invalid-integrity",
      `${at}/integrity`,
      "Expected supported SRI algorithms with correctly sized base64 digests.",
    );
  }
}
