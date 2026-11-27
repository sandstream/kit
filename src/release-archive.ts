/**
 * The archive check of `kit triage release`: what kind of file a release asset is, read from its
 * first bytes, and for a tar, gzip'd tar or zip every member, each judged by `memberFindings`.
 * Nothing is extracted, and nothing in the file is run. A format kit cannot list without a
 * decompressor it does not ship (xz, bzip2, 7z) is `unverified`, never `pass`.
 */
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import * as zlib from "node:zlib";
import { memberFindings, type ArchiveMember } from "./release-archive-member.js";
import { listTar, TarFormatError } from "./release-archive-tar.js";
import { listZip, ZipFormatError } from "./release-archive-zip.js";

export type ArchiveStatus = "pass" | "fail" | "unverified";

export interface ArchiveReport {
  status: ArchiveStatus;
  detail: string;
  format: string;
  members: ArchiveMember[];
  findings: string[];
}

/** More members than this and the listing stops: `unverified`, not a partial pass. */
const MAX_MEMBERS = 100_000;
const SHOWN_FINDINGS = 10;

type Format = "tar" | "tar.gz" | "zip" | "gzip" | "binary" | { unreadable: string } | "unknown";

function head(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(512);
    const got = readSync(fd, buf, 0, 512, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const startsWith = (b: Buffer, bytes: number[]): boolean => bytes.every((v, i) => b[i] === v);

const OPAQUE: [number[], string][] = [
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], "xz"],
  [[0x42, 0x5a, 0x68], "bzip2"],
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "7z"],
  [[0x28, 0xb5, 0x2f, 0xfd], "zstd"],
];

const EXECUTABLE: number[][] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a], // PE (MZ)
  [0x23, 0x21], // #! script
];

/** The format, from the first 512 bytes. */
export function detectFormat(b: Buffer): Format {
  if (startsWith(b, [0x1f, 0x8b])) return "gzip";
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]))
    return "zip";
  if (b.length >= 263 && b.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  for (const [magic, name] of OPAQUE) if (startsWith(b, magic)) return { unreadable: name };
  if (EXECUTABLE.some((m) => startsWith(b, m))) return "binary";
  return "unknown";
}

function report(format: string, members: ArchiveMember[]): ArchiveReport {
  if (members.length > MAX_MEMBERS) {
    const detail = `${format} with more than ${MAX_MEMBERS} members: not all were read`;
    return { status: "unverified", detail, format, members: [], findings: [] };
  }
  const findings = members.flatMap(memberFindings);
  if (findings.length === 0) {
    const detail = `${format}, ${members.length} members, none absolute, escaping, setuid or special`;
    return { status: "pass", detail, format, members, findings };
  }
  const more =
    findings.length > SHOWN_FINDINGS ? ` (and ${findings.length - SHOWN_FINDINGS} more)` : "";
  const detail = `${findings.slice(0, SHOWN_FINDINGS).join("; ")}${more}`;
  return { status: "fail", detail, format, members, findings };
}

type Decompressor = () => NodeJS.ReadWriteStream;

/**
 * Run `use` over the file's bytes, decompressed when `make` is given, and close the file before
 * returning, however `use` ends. A stream left open would keep the file locked on Windows, where
 * the caller then removes the download.
 */
async function withBytes<T>(
  path: string,
  make: Decompressor | null,
  use: (bytes: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  const source = createReadStream(path);
  const inflate = make ? make() : null;
  const bytes = (inflate ? source.pipe(inflate) : source) as unknown as AsyncIterable<Buffer>;
  try {
    return await use(bytes);
  } finally {
    (inflate as unknown as { destroy?: () => void } | null)?.destroy?.();
    if (!source.closed) {
      const closed = once(source, "close");
      source.destroy();
      await closed;
    }
  }
}

async function firstBytes(bytes: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of bytes) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= 512) break;
  }
  return Buffer.concat(chunks).subarray(0, 512);
}

/** A compressed stream that holds a tar is listed; one that holds a single file is that file. */
async function decompressedReport(
  path: string,
  make: Decompressor,
  name: string,
): Promise<ArchiveReport> {
  const first = await withBytes(path, make, firstBytes);
  if (detectFormat(first) !== "tar") {
    const detail = `a single ${name}-compressed file, not an archive`;
    return { status: "pass", detail, format: name, members: [], findings: [] };
  }
  return report(
    `tar.${name === "gzip" ? "gz" : "zst"}`,
    await withBytes(path, make, (b) => listTar(b, MAX_MEMBERS)),
  );
}

function unverified(format: string, detail: string): ArchiveReport {
  return { status: "unverified", detail, format, members: [], findings: [] };
}

/** Node's zstd decompressor, where this Node has one (22.15+). */
function zstd(): Decompressor | null {
  const make = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
    .createZstdDecompress;
  return typeof make === "function" ? () => make() : null;
}

async function opaqueReport(path: string, name: string): Promise<ArchiveReport> {
  const make = name === "zstd" ? zstd() : null;
  if (!make) {
    return unverified(
      name,
      `${name}-compressed: kit ships no ${name} decompressor, so the members were not read`,
    );
  }
  return decompressedReport(path, make, "zstd");
}

/** A malformed archive: kit's own parsers, or zlib refusing the compressed stream. */
function isFormatError(e: unknown): e is Error {
  if (e instanceof TarFormatError || e instanceof ZipFormatError) return true;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^(?:Z_|ERR_BUFFER_TOO_LARGE)/.test(code);
}

/** Read the file at `path` and judge its members. Never throws on a malformed archive: that fails. */
export async function inspectArchive(path: string): Promise<ArchiveReport> {
  const format = detectFormat(head(path));
  try {
    if (format === "tar") {
      return report("tar", await withBytes(path, null, (b) => listTar(b, MAX_MEMBERS)));
    }
    if (format === "gzip") return await decompressedReport(path, createGunzip, "gzip");
    if (format === "zip") return report("zip", listZip(path, MAX_MEMBERS));
    if (typeof format === "object") return await opaqueReport(path, format.unreadable);
  } catch (e) {
    if (!isFormatError(e)) throw e;
    const what = typeof format === "object" ? format.unreadable : format;
    if (/zip64/.test(e.message)) return unverified(what, e.message);
    return {
      status: "fail",
      detail: `malformed ${what}: ${e.message}`,
      format: what,
      members: [],
      findings: [],
    };
  }
  if (format === "binary") {
    const detail = "a single executable or script, not an archive";
    return { status: "pass", detail, format, members: [], findings: [] };
  }
  return unverified("unknown", "not a format kit can read (tar, tar.gz, zip or an executable)");
}
