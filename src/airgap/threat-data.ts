/**
 * Verified offline threat-data bundle.
 *
 * In a no-egress enclave the scanners' vulnerability DBs (and the bumblebee
 * catalog) must be synced in from a connected host. The risk: stale or
 * *tampered* threat data silently degrades every downstream verdict. This module
 * gives that transfer a trust chain that is FULLY OFFLINE-VERIFIABLE (no Fulcio /
 * Rekor / network):
 *
 *   1. The bundle ships a `manifest.json` listing each artifact + its SHA-256,
 *      plus a detached `manifest.json.sig` — an Ed25519 signature over the
 *      manifest bytes, produced on the connected host with a key the enclave
 *      trusts out-of-band (configured via KIT_THREAT_DATA_PUBKEY).
 *   2. kit verifies the signature over the manifest, then SHA-256s every listed
 *      artifact against the manifest. Any failure → fail-closed (the whole
 *      bundle is rejected; `kit scan --airgap` refuses rather than scan against
 *      unverified data).
 *   3. Each artifact may declare an `env` var; on success kit points the scanner
 *      at the verified file (e.g. `GRYPE_DB_CACHE_DIR`). The bundle author
 *      declares the wiring, so kit hard-codes no scanner-version specifics.
 *
 * Pure/deterministic and dependency-injected (fs + hash) so it is fully tested
 * without real DBs. node:crypto only.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface ThreatArtifact {
  /** Path of the artifact relative to the bundle dir. */
  path: string;
  /** Lowercase hex SHA-256 of the artifact's bytes. */
  sha256: string;
  /** Optional: env var to set to the artifact's absolute path so a scanner finds it. */
  env?: string;
}

export interface ThreatManifest {
  /** Bundle schema version. */
  version: number;
  /** ISO-8601 build time (informational). */
  created?: string;
  artifacts: ThreatArtifact[];
}

/** Parse + shape-validate a manifest. Throws on anything malformed (fail-closed). */
export function parseManifest(json: string): ThreatManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("threat-data manifest is not valid JSON");
  }
  const m = obj as Partial<ThreatManifest>;
  if (typeof m.version !== "number") throw new Error("manifest: missing numeric `version`");
  if (!Array.isArray(m.artifacts)) throw new Error("manifest: `artifacts` must be an array");
  for (const [i, a] of m.artifacts.entries()) {
    if (!a || typeof a.path !== "string" || !a.path) {
      throw new Error(`manifest: artifact[${i}] missing \`path\``);
    }
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(a.sha256)) {
      throw new Error(`manifest: artifact[${i}] (${a.path}) has no valid sha256`);
    }
    if (a.env !== undefined && (typeof a.env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(a.env))) {
      throw new Error(`manifest: artifact[${i}] (${a.path}) has an invalid env var name`);
    }
    if (a.path.includes("..") || a.path.startsWith("/")) {
      // never let a manifest point outside the bundle dir
      throw new Error(`manifest: artifact[${i}] path escapes the bundle: ${a.path}`);
    }
  }
  return m as ThreatManifest;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verify a detached Ed25519 signature over the manifest bytes. Never throws. */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signature: Buffer,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    // Ed25519: algorithm is null; key type is enforced by the key object.
    return cryptoVerify(null, manifestBytes, key, signature);
  } catch {
    return false;
  }
}

export type VerifyResult =
  | { ok: true; env: Record<string, string>; artifacts: number }
  | { ok: false; reason: string };

export interface VerifyDeps {
  /** Absolute bundle directory. */
  dir: string;
  /** Trusted Ed25519 public key (PEM/SPKI), out-of-band. */
  publicKeyPem: string;
  /** Read a file under the bundle as bytes; reject (throw) if missing. */
  readFile: (relPath: string) => Buffer;
  /** Resolve a bundle-relative path to the absolute path used for env wiring. */
  resolvePath: (relPath: string) => string;
}

/**
 * Verify a threat-data bundle end to end: signature over the manifest, then
 * SHA-256 of every artifact. Returns the env map to wire scanners on success;
 * a single problem fails the whole bundle (fail-closed).
 */
export function verifyThreatData(deps: VerifyDeps): VerifyResult {
  let manifestBytes: Buffer;
  let sigB64: Buffer;
  try {
    manifestBytes = deps.readFile("manifest.json");
  } catch {
    return { ok: false, reason: "manifest.json not found in bundle" };
  }
  try {
    sigB64 = deps.readFile("manifest.json.sig");
  } catch {
    return { ok: false, reason: "manifest.json.sig (detached signature) not found in bundle" };
  }

  const signature = Buffer.from(sigB64.toString("utf8").trim(), "base64");
  if (!verifyManifestSignature(manifestBytes, signature, deps.publicKeyPem)) {
    return { ok: false, reason: "manifest signature does not verify against the trusted key" };
  }

  let manifest: ThreatManifest;
  try {
    manifest = parseManifest(manifestBytes.toString("utf8"));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const env: Record<string, string> = {};
  for (const a of manifest.artifacts) {
    let bytes: Buffer;
    try {
      bytes = deps.readFile(a.path);
    } catch {
      return { ok: false, reason: `artifact missing: ${a.path}` };
    }
    const actual = sha256Hex(bytes);
    if (actual.toLowerCase() !== a.sha256.toLowerCase()) {
      return { ok: false, reason: `artifact tampered (sha256 mismatch): ${a.path}` };
    }
    if (a.env) env[a.env] = deps.resolvePath(a.path);
  }
  return { ok: true, env, artifacts: manifest.artifacts.length };
}
