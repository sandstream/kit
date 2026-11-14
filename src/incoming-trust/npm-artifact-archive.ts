import { gunzipSync } from "node:zlib";

export type NpmArchiveResult =
  | {
      status: "verified";
      root: string;
      manifestBytes: Buffer;
      entryCount: number;
      uncompressedBytes: number;
    }
  | { status: "rejected" | "unsupported"; reason: string };

// Inclusive private defaults. Callers can lower these limits, never raise them.
const DEFAULT_LIMITS = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  decompressedBytes: 64 * 1024 * 1024,
  entries: 10_000,
  metadataBytes: 1024 * 1024,
  metadataBodyBytes: 64 * 1024,
  pathBytes: 4096,
  manifestBytes: 1024 * 1024,
});

export type NpmArchiveLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

function readLimits(overrides: Partial<NpmArchiveLimits>): NpmArchiveLimits {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    fail("rejected", "invalid-limits");
  }
  const limits: NpmArchiveLimits = { ...DEFAULT_LIMITS };
  for (const key of Reflect.ownKeys(overrides)) {
    if (typeof key !== "string" || !Object.hasOwn(DEFAULT_LIMITS, key))
      fail("rejected", "invalid-limits");
    const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    const value: unknown = descriptor?.value;
    const name = key as keyof NpmArchiveLimits;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > DEFAULT_LIMITS[name]
    ) {
      fail("rejected", "invalid-limits");
    }
    limits[name] = value;
  }
  return limits;
}

type Refusal = Extract<NpmArchiveResult, { reason: string }>;

class ArchiveFailure extends Error {
  constructor(readonly result: Refusal) {
    super(result.reason);
  }
}

function fail(status: Refusal["status"], reason: string): never {
  throw new ArchiveFailure({ status, reason });
}

function zero(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function ownedCopy(bytes: Buffer): Buffer {
  const copy = Buffer.allocUnsafeSlow(bytes.length);
  copy.set(bytes);
  return copy;
}

function inflate(bytes: Buffer, limits: NpmArchiveLimits): Buffer {
  if (bytes.length > limits.compressedBytes) fail("unsupported", "compressed-limit");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) fail("unsupported", "compression-format");
  let inflated: unknown;
  try {
    inflated = gunzipSync(ownedCopy(bytes), {
      info: true,
      maxOutputLength: limits.decompressedBytes,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      fail("unsupported", "decompressed-limit");
    }
    fail("rejected", "gzip-invalid");
  }
  const info = inflateInfo(inflated);
  if (info.bytesWritten !== bytes.length) fail("unsupported", "gzip-residual-bytes");
  return info.buffer;
}

// Current Node types declare Buffer even when info:true returns this object.
function inflateInfo(inflated: unknown): { buffer: Buffer; bytesWritten: number } {
  const unavailable = () => fail("unsupported", "gzip-accounting-unavailable");
  if (typeof inflated !== "object" || inflated === null) return unavailable();
  const { buffer, engine } = inflated as { buffer?: unknown; engine?: unknown };
  if (!Buffer.isBuffer(buffer)) return unavailable();
  if (typeof engine !== "object" || engine === null) return unavailable();
  const bytesWritten = (engine as { bytesWritten?: unknown }).bytesWritten;
  if (!("bytesWritten" in engine) || typeof bytesWritten !== "number") return unavailable();
  return { buffer, bytesWritten };
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("rejected", "invalid-utf8");
  }
}

function textField(bytes: Buffer, mustTerminate = false): string {
  const end = bytes.indexOf(0);
  if (end === -1) {
    if (mustTerminate) fail("rejected", "tar-string-termination");
    return utf8(bytes);
  }
  if (!zero(bytes.subarray(end))) fail("rejected", "tar-string-padding");
  return utf8(bytes.subarray(0, end));
}

function octal(bytes: Buffer, allowEmpty = false): number {
  if ((bytes[0] & 0x80) !== 0) fail("unsupported", "tar-base256");
  const value = bytes.toString("latin1");
  if (allowEmpty && /^[\0 ]+$/.test(value)) return 0;
  if (!/^ *[0-7]+[\0 ]+$/.test(value)) fail("rejected", "tar-numeric");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail("unsupported", "tar-numeric-range");
  return parsed;
}

type Header = { path: string; size: number; type: string; link: string };

function headerPrefix(header: Buffer, gnu: boolean): string {
  if (gnu) {
    octal(header.subarray(345, 357), true);
    octal(header.subarray(357, 369), true);
    const offset = octal(header.subarray(369, 381), true);
    if (offset !== 0 || !zero(header.subarray(381))) fail("unsupported", "gnu-header-extension");
    return "";
  }
  const prefix = textField(header.subarray(345, 500));
  if (!zero(header.subarray(500))) fail("unsupported", "tar-header-extension");
  return prefix;
}

function readHeader(header: Buffer): Header {
  const expected = octal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  if (sum !== expected) fail("rejected", "tar-checksum");
  const magic = header.subarray(257, 265).toString("latin1");
  const gnu = magic === "ustar  \0";
  if (!gnu && magic !== "ustar\0" + "00") fail("unsupported", "tar-format");
  const name = textField(header.subarray(0, 100));
  const mode = octal(header.subarray(100, 108));
  if (mode > 0o7777) fail("unsupported", "tar-mode-extension");
  octal(header.subarray(108, 116));
  octal(header.subarray(116, 124));
  const size = octal(header.subarray(124, 136));
  octal(header.subarray(136, 148));
  const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
  const link = textField(header.subarray(157, 257));
  textField(header.subarray(265, 297), true);
  textField(header.subarray(297, 329), true);
  const major = octal(header.subarray(329, 337), true);
  const minor = octal(header.subarray(337, 345), true);
  const prefix = headerPrefix(header, gnu);
  if (!["0", "5", "x", "g"].includes(type)) fail("unsupported", "tar-entry-type");
  if (major !== 0 || minor !== 0) fail("unsupported", "tar-device-metadata");
  return { path: prefix ? `${prefix}/${name}` : name, size, type, link };
}

function bodyEnd(tar: Buffer, start: number, size: number): number {
  if (size > tar.length - start) fail("rejected", "tar-body-truncated");
  const end = start + Math.ceil(size / 512) * 512;
  if (end > tar.length) fail("rejected", "tar-padding-truncated");
  if (!zero(tar.subarray(start + size, end))) fail("rejected", "tar-body-padding");
  return end;
}

type Pax = Map<string, string>;

const PAX_NUMBER = new Set(["size", "uid", "gid"]);
const PAX_TIME = new Set(["mtime", "atime", "ctime"]);
const PAX_STRING = new Set(["path", "linkpath", "uname", "gname"]);
// Informational only. No payload conversion, lookup, or restoration occurs.
const PAX_INFORMATIONAL = new Set(["comment", "charset"]);

function validatePaxValue(key: string, value: string): void {
  if (PAX_NUMBER.has(key)) {
    if (value && !/^[0-9]+$/.test(value)) fail("rejected", "pax-number");
  } else if (PAX_TIME.has(key)) {
    if (value && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) fail("rejected", "pax-time");
  } else if (PAX_STRING.has(key)) {
    if (value.includes("\0")) fail("rejected", "pax-string");
  } else if (key === "hdrcharset") {
    if (value && value !== "ISO-IR 10646 2000 UTF-8") fail("unsupported", "pax-charset");
  } else if (!PAX_INFORMATIONAL.has(key)) {
    fail("unsupported", "pax-keyword");
  }
}

function readPax(body: Buffer, values: Pax): void {
  if (body.length === 0) fail("rejected", "pax-record");
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    if (space < 0) fail("rejected", "pax-record");
    const digits = body.subarray(offset, space).toString("latin1");
    if (!/^[0-9]+$/.test(digits)) fail("rejected", "pax-record");
    const length = Number(digits);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 3 ||
      length > body.length - offset
    ) {
      fail("rejected", "pax-record");
    }
    const end = offset + length;
    if (body[end - 1] !== 10) fail("rejected", "pax-record");
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(61);
    if (equals <= 0) fail("rejected", "pax-record");
    const key = utf8(record.subarray(0, equals));
    const value = utf8(record.subarray(equals + 1));
    validatePaxValue(key, value);
    // Last record wins. Empty values remain tombstones, including in global state.
    values.set(key, value);
    offset = end;
  }
}

function applyPax(header: Header, global: Pax, local: Pax): Header {
  const path = local.get("path") ?? global.get("path");
  const size = local.get("size") ?? global.get("size");
  const link = local.get("linkpath") ?? global.get("linkpath");
  // POSIX deletes the raw field too. Falling back would invent a path or size.
  if (path === "" || size === "") fail("unsupported", "pax-deleted-required-field");
  const effectiveSize = size === undefined ? header.size : Number(size);
  if (!Number.isSafeInteger(effectiveSize)) fail("unsupported", "pax-numeric-range");
  return { ...header, path: path ?? header.path, size: effectiveSize, link: link ?? header.link };
}

function normalizePath(value: string, directory: boolean, limit: number): string {
  if (Buffer.byteLength(value, "utf8") > limit) fail("unsupported", "path-limit");
  if (/[\\\x00-\x1f\x7f-\x9f]/.test(value)) fail("rejected", "unsafe-path");
  while (value.startsWith("./")) value = value.slice(2);
  if (directory && value.endsWith("/")) value = value.slice(0, -1);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /^[A-Za-z]:/.test(part))) {
    fail("rejected", "unsafe-path");
  }
  if (!directory && parts.length < 2) fail("rejected", "root-not-directory");
  return value;
}

/**
 * The key a case-insensitive or normalizing filesystem would give a path. Two entries that share a
 * key can overwrite each other on macOS or Windows, so they must not coexist in one archive.
 */
function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function checkAncestors(exact: Map<string, string>): void {
  const entries = new Map([...exact].map(([path, type]) => [foldPath(path), type] as const));
  const paths = [...entries.keys()].sort();
  for (const [path, type] of entries) {
    if (type !== "0") continue;
    const prefix = path + "/";
    let low = 0;
    let high = paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (paths[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    if (paths[low]?.startsWith(prefix)) fail("rejected", "path-conflict");
  }
}

function checkMetadata(
  header: Header,
  localPending: boolean,
  metadataBytes: number,
  limits: NpmArchiveLimits,
): number {
  if (localPending) fail("unsupported", "pax-sequence");
  if (header.size > limits.metadataBodyBytes) fail("unsupported", "metadata-body-limit");
  const total = metadataBytes + header.size;
  if (total > limits.metadataBytes) fail("unsupported", "metadata-limit");
  return total;
}

function checkTerminator(tar: Buffer, offset: number): void {
  if (tar.length - offset < 1024) fail("rejected", "tar-terminator");
  if (!zero(tar.subarray(offset))) fail("rejected", "tar-trailing-data");
}

function checkEntryShape(header: Header): void {
  if (header.link) fail("unsupported", "tar-link-metadata");
  if (header.type === "5" && header.size !== 0) fail("unsupported", "directory-body");
}

function registerEntry(
  entries: Map<string, string>,
  folded: Map<string, string>,
  header: Header,
): void {
  if (entries.has(header.path)) {
    fail("rejected", entries.get(header.path) === header.type ? "path-duplicate" : "path-conflict");
  }
  const key = foldPath(header.path);
  if (folded.has(key)) fail("rejected", "path-conflict");
  folded.set(key, header.path);
  entries.set(header.path, header.type);
}

function manifestFor(
  tar: Buffer,
  offset: number,
  header: Header,
  root: string,
  limits: NpmArchiveLimits,
): Buffer | undefined {
  if (header.path !== `${root}/package.json`) return undefined;
  if (header.type !== "0") fail("rejected", "manifest-type");
  if (header.size > limits.manifestBytes) fail("unsupported", "manifest-limit");
  return ownedCopy(tar.subarray(offset, offset + header.size));
}

function inspectTar(tar: Buffer, limits: NpmArchiveLimits): NpmArchiveResult {
  if (tar.length % 512 !== 0) fail("rejected", "tar-block-alignment");
  let offset = 0;
  let entryCount = 0;
  let root = "";
  let manifestBytes: Buffer | undefined;
  let terminated = false;
  const entries = new Map<string, string>();
  const folded = new Map<string, string>();
  const global: Pax = new Map();
  let local: Pax = new Map();
  let localPending = false;
  let metadataPending = false;
  let metadataBytes = 0;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (zero(block)) {
      checkTerminator(tar, offset);
      terminated = true;
      break;
    }
    if (++entryCount > limits.entries) fail("unsupported", "entry-limit");
    let header = readHeader(block);
    offset += 512;
    if (header.type === "x" || header.type === "g") {
      metadataBytes = checkMetadata(header, localPending, metadataBytes, limits);
      const end = bodyEnd(tar, offset, header.size);
      readPax(tar.subarray(offset, offset + header.size), header.type === "g" ? global : local);
      localPending = header.type === "x";
      metadataPending = true;
      offset = end;
      continue;
    }
    header = applyPax(header, global, local);
    local = new Map();
    localPending = false;
    metadataPending = false;
    checkEntryShape(header);
    const end = bodyEnd(tar, offset, header.size);
    header.path = normalizePath(header.path, header.type === "5", limits.pathBytes);
    const entryRoot = header.path.split("/")[0];
    if (root && root !== entryRoot) fail("rejected", "multiple-roots");
    root = entryRoot;
    registerEntry(entries, folded, header);
    manifestBytes = manifestFor(tar, offset, header, root, limits) ?? manifestBytes;
    offset = end;
  }
  if (!terminated) fail("rejected", "tar-terminator");
  if (metadataPending) fail("rejected", "pax-dangling");
  checkAncestors(entries);
  if (!manifestBytes) fail("rejected", "manifest-missing");
  return { status: "verified", root, manifestBytes, entryCount, uncompressedBytes: tar.length };
}

/** Inspect the entire archive structure. This grants no identity or execution approval. */
export function inspectNpmTarball(
  bytes: Buffer,
  lowerLimits: Partial<NpmArchiveLimits> = {},
): NpmArchiveResult {
  if (!Buffer.isBuffer(bytes)) return { status: "rejected", reason: "invalid-bytes" };
  try {
    const limits = readLimits(lowerLimits);
    return inspectTar(inflate(bytes, limits), limits);
  } catch (error) {
    if (error instanceof ArchiveFailure) return error.result;
    return { status: "rejected", reason: "archive-invalid" };
  }
}
