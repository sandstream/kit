/**
 * The signature check of `kit triage release`. Two kinds are verified, both with node:crypto and a
 * key the user names, never one taken from the release itself (whoever can replace the asset can
 * replace a key next to it):
 *
 *   - minisign (`<file>.minisig`, `--minisign-key`): Ed25519 over the file, or over its BLAKE2b-512
 *     for prehashed `ED` signatures, plus the global signature over the trusted comment;
 *   - cosign with a key (`<file>.sig`, `--cosign-key <pem>`): ECDSA or RSA over SHA-256 of the file.
 *
 * Anything else (OpenPGP `.asc`, keyless cosign bundles that need Fulcio and Rekor, a signature
 * with no key given) is `unverified` and says why. Nothing is ever a silent pass.
 */
import { createHash, createPublicKey, createVerify, verify, type KeyObject } from "node:crypto";

export type SignatureStatus = "pass" | "fail" | "unverified";
export interface SignatureCheck {
  status: SignatureStatus;
  detail: string;
}

/** A file that may carry a signature: its label, a fresh stream of its bytes, and the signature files found next to it. */
export interface SignedFile {
  label: string;
  bytes: () => AsyncIterable<Buffer>;
  /** Signature file contents by suffix (".minisig", ".sig", ".asc", ".sigstore.json", ".bundle"). */
  signatures: Record<string, string>;
}

export interface SignatureKeys {
  /** A minisign public key: the base64 line of a `minisign.pub`, or the whole file. */
  minisignKey?: string;
  /** A PEM public key for cosign `sign-blob --key` signatures. */
  cosignKey?: string;
}

export const SIGNATURE_SUFFIXES = [
  ".minisig",
  ".sig",
  ".asc",
  ".sigstore.json",
  ".sigstore",
  ".bundle",
];

interface MinisignKey {
  id: Buffer;
  key: KeyObject;
}

/** The base64 payload line of a minisign file (the line after an `untrusted comment:` line, or the only one). */
function payloadLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex((l) => !l.startsWith("untrusted comment:"));
  return at < 0 ? undefined : lines[at];
}

export function parseMinisignKey(text: string): MinisignKey | null {
  const raw = Buffer.from(payloadLine(text) ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") return null;
  const x = raw.subarray(10).toString("base64url");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return { id: raw.subarray(2, 10), key };
}

interface Minisig {
  prehashed: boolean;
  id: Buffer;
  signature: Buffer;
  trusted: string;
  global: Buffer;
}

export function parseMinisig(text: string): Minisig | null {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[2]?.startsWith("trusted comment: "))
    return null;
  const sig = Buffer.from(lines[1]!.trim(), "base64");
  const global = Buffer.from((lines[3] ?? "").trim(), "base64");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (sig.length !== 74 || global.length !== 64 || (alg !== "Ed" && alg !== "ED")) return null;
  return {
    prehashed: alg === "ED",
    id: sig.subarray(2, 10),
    signature: sig.subarray(10),
    trusted: lines[2].slice("trusted comment: ".length),
    global,
  };
}

/** Largest file a non-prehashed minisign signature is checked over (it needs the whole file in memory). */
const MAX_LEGACY = 256 * 1024 * 1024;

async function collect(bytes: AsyncIterable<Buffer>, hash?: string): Promise<Buffer | null> {
  if (hash) {
    const h = createHash(hash);
    for await (const chunk of bytes) h.update(chunk);
    return h.digest();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of bytes) {
    size += chunk.length;
    if (size > MAX_LEGACY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function verifyMinisign(
  file: SignedFile,
  sigText: string,
  keyText: string,
): Promise<SignatureCheck> {
  const key = parseMinisignKey(keyText);
  if (!key)
    return { status: "fail", detail: "--minisign-key is not a minisign Ed25519 public key" };
  const sig = parseMinisig(sigText);
  if (!sig) return { status: "fail", detail: `${file.label}.minisig is not a minisign signature` };
  if (!sig.id.equals(key.id)) {
    return {
      status: "fail",
      detail: `${file.label}.minisig was made with another key (id ${sig.id.toString("hex")})`,
    };
  }
  const message = await collect(file.bytes(), sig.prehashed ? "blake2b512" : undefined);
  if (!message)
    return {
      status: "unverified",
      detail: `${file.label} is too large for a non-prehashed minisign check`,
    };
  if (!verify(null, message, key.key, sig.signature)) {
    return { status: "fail", detail: `${file.label}.minisig does not verify with the given key` };
  }
  const globalOk = verify(
    null,
    Buffer.concat([sig.signature, Buffer.from(sig.trusted)]),
    key.key,
    sig.global,
  );
  if (!globalOk)
    return {
      status: "fail",
      detail: `${file.label}.minisig has a trusted comment the key did not sign`,
    };
  return {
    status: "pass",
    detail: `${file.label} verifies with minisign key ${key.id.toString("hex")}`,
  };
}

export async function verifyCosign(
  file: SignedFile,
  sigText: string,
  pem: string,
): Promise<SignatureCheck> {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    return { status: "fail", detail: "--cosign-key is not a PEM public key" };
  }
  const sig = Buffer.from(sigText.trim(), "base64");
  if (sig.length === 0)
    return { status: "fail", detail: `${file.label}.sig is empty or not base64` };
  const v = createVerify("SHA256");
  for await (const chunk of file.bytes()) v.update(chunk);
  return safeVerify(() => v.verify(key, sig))
    ? { status: "pass", detail: `${file.label} verifies with the given cosign key` }
    : { status: "fail", detail: `${file.label}.sig does not verify with the given cosign key` };
}

/** A verifier that throws on a malformed signature has not verified it. */
function safeVerify(run: () => boolean): boolean {
  try {
    return run();
  } catch {
    return false;
  }
}

/** Why a signature kit found was not checked. */
function unverifiedReason(found: string[], keys: SignatureKeys): string {
  const names = found.join(", ");
  if (found.some((f) => f.endsWith(".minisig")) && !keys.minisignKey) {
    return `${names} published, but no --minisign-key was given (kit takes no key from the release itself)`;
  }
  if (found.some((f) => f.endsWith(".sig")) && !keys.cosignKey) {
    return `${names} published, but no --cosign-key was given (kit takes no key from the release itself)`;
  }
  return `${names} published; OpenPGP and keyless Sigstore signatures have no dependency-free check in kit`;
}

/** Check the first file that carries a signature kit can verify with the keys given. */
export async function checkSignatures(
  files: SignedFile[],
  keys: SignatureKeys,
): Promise<SignatureCheck> {
  const found: string[] = [];
  for (const file of files) {
    const s = file.signatures;
    for (const suffix of Object.keys(s)) found.push(`${file.label}${suffix}`);
    if (s[".minisig"] !== undefined && keys.minisignKey) {
      return verifyMinisign(file, s[".minisig"], keys.minisignKey);
    }
    if (s[".sig"] !== undefined && keys.cosignKey)
      return verifyCosign(file, s[".sig"], keys.cosignKey);
  }
  if (keys.minisignKey || keys.cosignKey) {
    // A key says a signature is expected. A release without the matching file is not a pass.
    const which = keys.minisignKey ? ".minisig" : ".sig";
    const seen = found.length ? ` (found: ${found.join(", ")})` : "";
    return {
      status: "fail",
      detail: `a key was given, but no ${which} is published next to the asset or its checksum file${seen}`,
    };
  }
  if (found.length === 0) {
    return {
      status: "unverified",
      detail: "no signature is published next to the asset or its checksum file",
    };
  }
  return { status: "unverified", detail: unverifiedReason(found, keys) };
}
