/**
 * Binary files in a package tarball that are neither a known executable nor a known media
 * type: a blob only its publisher can explain.
 *
 * Three deterministic steps, no heuristics on entropy:
 *  1. Binary or text: a NUL byte in the first 8000 bytes means binary (git's rule).
 *     Known media and font types, recognised by their first bytes, are left alone.
 *  2. One layer in: gzip and zip streams found anywhere in the file are decompressed a
 *     little (at most `STREAM_INPUT` bytes in, `MAX_OUTPUT` out, so a bomb cannot expand)
 *     and the result is classified like any other file. xz and zstd are named, not opened:
 *     Node's standard library cannot read them and kit adds no dependency for it.
 *  3. Disguise: binary content in a file with a text extension (`.js`, `.json`, `.md`, …).
 *
 * The result is a fact for the report, never a verdict.
 */
import { open, readFile } from "node:fs/promises";
import { constants as zc, gunzipSync, inflateRawSync } from "node:zlib";
import { binaryKind, type BinaryKind } from "./triage-sandbox-binary.js";

/** Bytes git looks at to decide binary vs text. */
const TEXT_PROBE = 8000;
/** Compressed bytes fed to the decompressor per stream: enough to reveal a header. */
const STREAM_INPUT = 16 * 1024;
/** Decompressed bytes allowed per stream before it counts as a bomb and is skipped. */
const MAX_OUTPUT = 16 * 1024 * 1024;
/** Files larger than this are only named, not searched for streams. */
const MAX_SCAN = 64 * 1024 * 1024;
const MAX_STREAMS = 8;
/** An unknown binary at or above this size is a warning; smaller ones are info. */
export const UNKNOWN_WARN_BYTES = 256 * 1024;

const TEXT_EXT = /\.(c?js|mjs|ts|mts|cts|jsx|tsx|json|md|txt|ya?ml|css|html?)$/i;

export interface BlobFinding {
  severity: "info" | "warn";
  detail: string;
}

function startsWith(b: Uint8Array, at: number, bytes: number[] | string): boolean {
  const arr = typeof bytes === "string" ? [...bytes].map((c) => c.charCodeAt(0)) : bytes;
  if (b.length < at + arr.length) return false;
  return arr.every((v, i) => b[at + i] === v);
}

const KNOWN_MEDIA: [string, (b: Uint8Array) => boolean][] = [
  ["PNG", (b) => startsWith(b, 0, [0x89, 0x50, 0x4e, 0x47])],
  ["JPEG", (b) => startsWith(b, 0, [0xff, 0xd8, 0xff])],
  ["GIF", (b) => startsWith(b, 0, "GIF8")],
  ["WebP", (b) => startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")],
  ["ICO", (b) => startsWith(b, 0, [0, 0, 1, 0])],
  ["WOFF", (b) => startsWith(b, 0, "wOFF") || startsWith(b, 0, "wOF2")],
  ["TrueType", (b) => startsWith(b, 0, [0, 1, 0, 0]) || startsWith(b, 0, "OTTO")],
  ["PDF", (b) => startsWith(b, 0, "%PDF")],
];

/** The known media type `b` starts with, or null. */
export function mediaKind(b: Uint8Array): string | null {
  return KNOWN_MEDIA.find(([, test]) => test(b))?.[0] ?? null;
}

/** True when `b` looks binary by git's rule: a NUL byte in the first 8000 bytes. */
export function looksBinary(b: Uint8Array): boolean {
  return b.subarray(0, TEXT_PROBE).includes(0);
}

type StreamFormat = "gzip" | "zip" | "xz" | "zstd";

const STREAM_MAGIC: [StreamFormat, number[]][] = [
  ["gzip", [0x1f, 0x8b, 0x08]],
  ["zip", [0x50, 0x4b, 0x03, 0x04]],
  ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ["zstd", [0x28, 0xb5, 0x2f, 0xfd]],
];

/** Offsets of compressed streams in `b`, in file order, at most `MAX_STREAMS`. */
export function findStreams(b: Uint8Array): { format: StreamFormat; offset: number }[] {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const found: { format: StreamFormat; offset: number }[] = [];
  for (const [format, magic] of STREAM_MAGIC) {
    const needle = Buffer.from(magic);
    for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) {
      found.push({ format, offset: at });
      if (found.length >= MAX_STREAMS * 4) break;
    }
  }
  return found.sort((a, b2) => a.offset - b2.offset).slice(0, MAX_STREAMS);
}

/** The first decompressed bytes of a zip entry's local header at `offset`, or null. */
function zipHead(b: Uint8Array, offset: number): Uint8Array | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (offset + 30 > buf.length) return null;
  const method = buf.readUInt16LE(offset + 8);
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  const data = buf.subarray(start, start + STREAM_INPUT);
  if (method === 0) return data;
  if (method !== 8) return null;
  return inflateRawSync(data, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: MAX_OUTPUT });
}

/** The first decompressed bytes of the stream at `offset`, or null when it cannot be read. */
export function streamHead(b: Uint8Array, format: StreamFormat, offset: number): Uint8Array | null {
  try {
    if (format === "gzip") {
      const input = b.subarray(offset, offset + STREAM_INPUT);
      return gunzipSync(input, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: MAX_OUTPUT });
    }
    if (format === "zip") return zipHead(b, offset);
  } catch {
    // A false-positive magic, a corrupt stream, or one that expands past the bomb ceiling.
  }
  return null;
}

/** An executable or boot image hidden one compression layer inside `b`, if any. */
export function hiddenInside(
  b: Uint8Array,
): { kind: BinaryKind; format: StreamFormat; offset: number } | null {
  for (const { format, offset } of findStreams(b)) {
    const head = streamHead(b, format, offset);
    const kind = head ? binaryKind(head) : null;
    if (kind) return { kind, format, offset };
  }
  return null;
}

/** Describe a binary file that `binaryKind` did not recognise, or null when there is nothing to say. */
export function describeBlob(path: string, b: Uint8Array, size: number): BlobFinding | null {
  if (!looksBinary(b) || mediaKind(b)) return null;
  const inner = size <= MAX_SCAN ? hiddenInside(b) : null;
  if (inner) {
    return {
      severity: "warn",
      detail: `${path}: ${inner.kind.kind} inside a ${inner.format} stream at offset ${inner.offset} (${size} bytes)`,
    };
  }
  if (TEXT_EXT.test(path)) {
    return { severity: "warn", detail: `${path}: binary content in a text file (${size} bytes)` };
  }
  const opaque = findStreams(b).find((s) => s.format === "xz" || s.format === "zstd");
  const note = opaque ? `, contains a ${opaque.format} stream kit cannot open` : "";
  return {
    severity: size >= UNKNOWN_WARN_BYTES ? "warn" : "info",
    detail: `${path}: unknown binary (${size} bytes${note})`,
  };
}

/** The first `TEXT_PROBE` bytes of `full`, or null when it cannot be read. */
async function probe(full: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(full, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(TEXT_PROBE);
    const { bytesRead } = await handle.read(buf, 0, TEXT_PROBE, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Describe `full` as a blob. Text and known media stop after an 8000-byte probe; only a
 * binary of unknown kind is read further (up to `MAX_SCAN` bytes) to look for streams.
 */
export async function inspectBlob(
  full: string,
  path: string,
  size: number,
): Promise<BlobFinding | null> {
  const head = await probe(full);
  if (!head || !looksBinary(head) || mediaKind(head)) return null;
  let b: Uint8Array = head;
  if (size > head.length && size <= MAX_SCAN) {
    try {
      b = await readFile(full);
    } catch {
      return null;
    }
  }
  return describeBlob(path, b, size);
}
