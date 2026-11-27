/**
 * List the members of a zip file from its central directory, without extracting anything. Unix
 * modes come from the external attributes of entries a Unix host made; a symlink's target is its
 * (small) stored data, inflated with a cap. Zip64 archives are refused, not guessed at.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { ArchiveMember } from "./release-archive-member.js";

export class ZipFormatError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_LINK = 4096;
const S_IFMT = 0o170000;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const got = readSync(fd, buf, 0, length, position);
  if (got !== length) throw new ZipFormatError("the file ends early");
  return buf;
}

interface Directory {
  count: number;
  size: number;
  offset: number;
}

function endRecord(fd: number, fileSize: number): Directory {
  const tail = Math.min(fileSize, 22 + MAX_COMMENT);
  const buf = readAt(fd, fileSize - tail, tail);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const count = buf.readUInt16LE(i + 10);
    const size = buf.readUInt32LE(i + 12);
    const offset = buf.readUInt32LE(i + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ZipFormatError("zip64 archives are not read");
    }
    if (offset + size > fileSize) throw new ZipFormatError("the central directory is out of range");
    return { count, size, offset };
  }
  throw new ZipFormatError("no end-of-central-directory record");
}

function kindOf(mode: number, name: string): ArchiveMember["kind"] {
  const type = mode & S_IFMT;
  if (type === 0o120000) return "symlink";
  if (type === 0o040000 || name.endsWith("/")) return "dir";
  if (type === 0 || type === 0o100000) return "file";
  return "special";
}

function linkTarget(fd: number, entry: Buffer, at: number): string {
  const method = entry.readUInt16LE(at + 10);
  const compressed = entry.readUInt32LE(at + 20);
  const local = entry.readUInt32LE(at + 42);
  const header = readAt(fd, local, 30);
  if (header.readUInt32LE(0) !== LOCAL) throw new ZipFormatError("a local header is missing");
  if (compressed > MAX_LINK * 4) throw new ZipFormatError("a symlink entry is too large");
  const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = readAt(fd, start, compressed);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_LINK }).toString("utf8");
  throw new ZipFormatError("a symlink entry uses an unknown compression method");
}

/** Every member, up to `limit` + 1. Throws ZipFormatError on a file that is not a readable zip. */
export function listZip(path: string, limit: number): ArchiveMember[] {
  const fd = openSync(path, "r");
  try {
    const dir = endRecord(fd, fstatSync(fd).size);
    const buf = readAt(fd, dir.offset, dir.size);
    const members: ArchiveMember[] = [];
    let at = 0;
    for (let i = 0; i < dir.count && members.length <= limit; i++) {
      if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
        throw new ZipFormatError("a central directory entry is malformed");
      }
      const unix = buf.readUInt8(at + 5) === 3;
      const nameLen = buf.readUInt16LE(at + 28);
      const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
      const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      const mode = unix ? buf.readUInt32LE(at + 38) >>> 16 : 0;
      const kind = kindOf(mode, name);
      const link = kind === "symlink" ? linkTarget(fd, buf, at) : undefined;
      members.push({ name, kind, mode: mode & 0o7777, link });
      at += 46 + skip;
    }
    return members;
  } finally {
    closeSync(fd);
  }
}
