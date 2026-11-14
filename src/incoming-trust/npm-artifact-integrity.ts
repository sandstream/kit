import { createHash } from "node:crypto";

export type StrongNpmAlgorithm = "sha256" | "sha384" | "sha512";

export type NpmIntegrityResult =
  | Readonly<{
      status: "verified";
      algorithm: StrongNpmAlgorithm;
      matchedToken: string;
      actualDigest: string;
      byteCount: number;
    }>
  | Readonly<{
      status: "rejected";
      reason: "invalid-bytes" | "malformed-metadata" | "weak-only" | "digest-mismatch";
    }>
  | Readonly<{ status: "unsupported"; reason: "noncanonical-base64" }>
  | Readonly<{ status: "unsupported"; reason: "metadata-limit" | "token-limit"; limit: number }>
  | Readonly<{
      status: "unsupported";
      reason: "unsupported-algorithm" | "algorithm-unavailable";
      algorithm: string;
    }>;

type ParsedToken = {
  algorithm: StrongNpmAlgorithm | "sha1";
  digest: string;
  source: string;
};

const digestLengths = new Map<string, number>([
  ["sha1", 20],
  ["sha256", 32],
  ["sha384", 48],
  ["sha512", 64],
]);

// Fixed private policy limits, inclusive. All whitespace and options count.
const MAX_METADATA_BYTES = 16_384;
const MAX_TOKENS = 64;

function parseToken(source: string): ParsedToken | NpmIntegrityResult {
  // W3C REC-SRI-20160623 section 3.5 permits empty and repeated option segments.
  const [hash, ...options] = source.split("?");
  if (options.some((option) => /[^\x21-\x7e]/.test(option))) {
    return { status: "rejected", reason: "malformed-metadata" };
  }
  const match = /^([A-Za-z0-9]+)-([A-Za-z0-9+/_-]+={0,2})$/.exec(hash);
  if (!match) return { status: "rejected", reason: "malformed-metadata" };
  const [, algorithm, digest] = match;
  const dataLength = digest.replace(/=+$/, "").length;
  if (dataLength % 4 === 1) {
    return { status: "rejected", reason: "malformed-metadata" };
  }
  const length = digestLengths.get(algorithm);
  if (length === undefined) {
    return { status: "unsupported", reason: "unsupported-algorithm", algorithm };
  }
  const decoded = Buffer.from(digest, "base64");
  if (decoded.length !== length) {
    return { status: "rejected", reason: "malformed-metadata" };
  }
  if (decoded.toString("base64") !== digest) {
    return { status: "unsupported", reason: "noncanonical-base64" };
  }
  return { algorithm: algorithm as ParsedToken["algorithm"], digest, source };
}

/** Compare an owned byte copy with SRI metadata. This grants no archive or execution approval. */
export function verifyNpmIntegrity(bytes: Buffer, integrity: unknown): NpmIntegrityResult {
  if (!Buffer.isBuffer(bytes)) return { status: "rejected", reason: "invalid-bytes" };
  if (typeof integrity !== "string") {
    return { status: "rejected", reason: "malformed-metadata" };
  }
  if (
    integrity.length > MAX_METADATA_BYTES ||
    Buffer.byteLength(integrity, "utf8") > MAX_METADATA_BYTES
  ) {
    return { status: "unsupported", reason: "metadata-limit", limit: MAX_METADATA_BYTES };
  }
  if (/[^\x09\x0a\x0c\x0d\x20-\x7e]/.test(integrity)) {
    return { status: "rejected", reason: "malformed-metadata" };
  }
  const sources = integrity.match(/[^\t\n\f\r ]+/g);
  if (!sources) return { status: "rejected", reason: "malformed-metadata" };
  if (sources.length > MAX_TOKENS) {
    return { status: "unsupported", reason: "token-limit", limit: MAX_TOKENS };
  }
  const tokens: ParsedToken[] = [];
  for (const source of sources) {
    const parsed = parseToken(source);
    if ("status" in parsed) return parsed;
    tokens.push(parsed);
  }
  const algorithm = (["sha512", "sha384", "sha256"] as const).find((candidate) =>
    tokens.some((token) => token.algorithm === candidate),
  );
  if (!algorithm) return { status: "rejected", reason: "weak-only" };
  // A separate allocation prevents shared Buffer pool storage with the caller.
  // Copy only the supplied view, before entering the native hash boundary.
  const snapshot = Buffer.allocUnsafeSlow(bytes.length);
  snapshot.set(bytes);
  let actualDigest: string;
  try {
    actualDigest = createHash(algorithm).update(snapshot).digest("base64");
  } catch {
    return { status: "unsupported", reason: "algorithm-unavailable", algorithm };
  }
  const matchedToken = tokens.find(
    (token) => token.algorithm === algorithm && token.digest === actualDigest,
  );
  if (!matchedToken) {
    return { status: "rejected", reason: "digest-mismatch" };
  }
  return {
    status: "verified",
    algorithm,
    matchedToken: matchedToken.source,
    actualDigest,
    byteCount: snapshot.length,
  };
}
