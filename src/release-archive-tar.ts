/**
 * List the members of a tar stream without extracting or running anything. Reads ustar, GNU long
 * names (`L`/`K`) and pax headers (`x`/`g` path and linkpath). Data blocks are skipped, never kept,
 * so a large archive costs time, not memory. Pure apart from the stream it is handed.
 */
import type { ArchiveMember } from "./release-archive-member.js";

const BLOCK = 512;
/** A long-name or pax record above this is not a name: refuse rather than buffer it. */
const MAX_META = 1_048_576;

export class TarFormatError extends Error {}

function text(block: Buffer, from: number, len: number): string {
  const slice = block.subarray(from, from + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

function octal(block: Buffer, from: number, len: number): number {
  const field = block.subarray(from, from + len);
  if (field[0]! & 0x80) {
    // base-256 (GNU): big-endian, first byte's high bit set. Only sizes this large are refused.
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    if (!Number.isSafeInteger(n)) throw new TarFormatError("a size field is too large");
    return n;
  }
  const s = text(block, from, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s))
    throw new TarFormatError(`a numeric field is not octal: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === octal(block, 148, 8);
}

/** `path` and `linkpath` from pax records ("<len> key=value\n"). */
function paxRecords(data: Buffer): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || at + len > data.length) {
      throw new TarFormatError("a pax record has a bad length");
    }
    const record = data.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    const key = record.slice(0, eq);
    if (key === "path" || key === "linkpath") out[key] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

interface Pending {
  name?: string;
  link?: string;
}

const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK;

/** A pull reader over an async byte stream: `take(n)` resolves with exactly n bytes, or null at the end. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly it: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      const next = await this.it.next();
      if (next.done) return false;
      this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    }
    return true;
  }
  async take(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async skip(n: number): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill(1))) return false;
      const step = Math.min(left, this.buf.length);
      this.buf = this.buf.subarray(step);
      left -= step;
    }
    return true;
  }
}

const KINDS: Record<string, ArchiveMember["kind"]> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "1": "hardlink",
  "2": "symlink",
  "5": "dir",
};
/** Entry types with no data blocks, whatever their size field says. */
const NO_DATA = new Set(["1", "2", "3", "4", "5", "6"]);

function member(block: Buffer, flag: string, pending: Pending): ArchiveMember {
  const prefix = text(block, 257, 6).startsWith("ustar") ? text(block, 345, 155) : "";
  const base = text(block, 0, 100);
  const name = pending.name ?? (prefix ? `${prefix}/${base}` : base);
  const kind = KINDS[flag] ?? "special";
  const linked = kind === "symlink" || kind === "hardlink";
  return {
    name,
    kind,
    mode: octal(block, 100, 8),
    link: linked ? (pending.link ?? text(block, 157, 100)) : undefined,
  };
}

/** Read a long-name or pax header into `pending`. A global pax path is refused: it renames every member. */
async function readMeta(
  reader: Reader,
  flag: string,
  size: number,
  pending: Pending,
): Promise<Pending> {
  if (size > MAX_META) throw new TarFormatError("a long-name or pax header is too large");
  const data = await reader.take(padded(size));
  if (!data) throw new TarFormatError("the archive ends inside a header");
  const body = data.subarray(0, size);
  if (flag === "L") return { ...pending, name: text(body, 0, size) };
  if (flag === "K") return { ...pending, link: text(body, 0, size) };
  const pax = paxRecords(body);
  if (flag === "g") {
    if (pax.path !== undefined || pax.linkpath !== undefined) {
      throw new TarFormatError("a global pax header renames members");
    }
    return pending;
  }
  return { name: pax.path ?? pending.name, link: pax.linkpath ?? pending.link };
}

const META = new Set(["L", "K", "x", "g"]);

/** Every member, in order, up to `limit` + 1. Throws TarFormatError on a header that is not tar. */
export async function listTar(
  source: AsyncIterable<Buffer>,
  limit: number,
): Promise<ArchiveMember[]> {
  const reader = new Reader(source);
  const members: ArchiveMember[] = [];
  let pending: Pending = {};
  for (;;) {
    const block = await reader.take(BLOCK);
    if (!block || block.every((b) => b === 0)) return members;
    if (!checksumOk(block)) throw new TarFormatError("a header checksum does not match");
    const size = octal(block, 124, 12);
    const flag = String.fromCharCode(block[156]!);
    if (META.has(flag)) {
      pending = await readMeta(reader, flag, size, pending);
      continue;
    }
    members.push(member(block, flag, pending));
    if (members.length > limit) return members;
    pending = {};
    const skipped = await reader.skip(padded(NO_DATA.has(flag) ? 0 : size));
    if (!skipped) throw new TarFormatError("the archive ends inside a member");
  }
}
