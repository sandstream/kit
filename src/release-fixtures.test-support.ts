// Archive fixtures built in memory, so the release triage tests need no tar or zip binary and
// never read a real download.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  /** tar typeflag: "0" file, "2" symlink, "1" hardlink, "5" dir, "3" char device. */
  type?: string;
  mode?: number;
  link?: string;
  data?: string;
}

function field(buf: Buffer, at: number, len: number, value: string): void {
  buf.write(value, at, len, "utf8");
}

const oct = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, "0")}\0`;

function header(name: string, size: number, type: string, mode: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  field(h, 0, 100, name);
  field(h, 100, 8, oct(mode, 8));
  field(h, 108, 8, oct(0, 8));
  field(h, 116, 8, oct(0, 8));
  field(h, 124, 12, oct(size, 12));
  field(h, 136, 12, oct(0, 12));
  h.fill(0x20, 148, 156);
  field(h, 156, 1, type);
  field(h, 157, 100, link);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A ustar archive. A name over 100 bytes goes in a pax header, as GNU tar writes it. */
export function makeTar(entries: FixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const type = e.type ?? "0";
    if (Buffer.byteLength(e.name) > 100) {
      const rec = ` path=${e.name}\n`;
      let len = rec.length;
      len += String(len + String(len).length).length;
      const pax = Buffer.from(`${len}${rec}`);
      parts.push(header("PaxHeader", pax.length, "x", 0o644), pad(pax));
    }
    const size = type === "0" ? data.length : 0;
    parts.push(header(e.name.slice(0, 100), size, type, e.mode ?? 0o644, e.link));
    if (size) parts.push(pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const makeTarGz = (entries: FixtureEntry[]): Buffer => gzipSync(makeTar(entries));

/** A zip whose entries a Unix host made (mode in the external attributes). Symlink data is deflated. */
export function makeZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const symlink = e.type === "2";
    const raw = Buffer.from(symlink ? (e.link ?? "") : (e.data ?? ""));
    const body = symlink ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const typeBits = symlink ? 0o120000 : e.type === "5" ? 0o040000 : 0o100000;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(symlink ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt8(3, 5);
    cen.writeUInt16LE(symlink ? 8 : 0, 10);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((typeBits | (e.mode ?? 0o644)) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** A scratch directory for one test file: `put` writes bytes and returns the path. */
export function scratchDir(prefix: string): {
  put: (name: string, bytes: Buffer) => string;
  remove: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    put: (name, bytes) => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
