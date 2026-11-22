import { isUtf8 } from "node:buffer";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const MAX_COMPRESSED = 16 * 1024 * 1024;
const MAX_INFLATED = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_PAX = 64 * 1024;

function refuse(reason: string): never {
  throw new Error(`APKINDEX.tar.gz: ${reason}`);
}

function isZero(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function octal(header: Buffer, start: number, length: number, blank = false): number {
  const text = header.subarray(start, start + length).toString("latin1");
  if (blank && header.subarray(start, start + length).every((byte) => byte === 0 || byte === 32))
    return 0;
  const match = /^ *([0-7]+)[\0 ]*$/.exec(text);
  if (!match || match[0] !== text) refuse(`invalid numeric field at ${start}`);
  const value = Number.parseInt(match[1], 8);
  if (!Number.isSafeInteger(value)) refuse(`numeric field exceeds supported range at ${start}`);
  return value;
}

function textField(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  if (nul >= 0 && !isZero(bytes.subarray(nul))) refuse("hidden text after a NUL byte");
  const value = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (!isUtf8(value)) refuse("invalid UTF-8 in a header");
  if (value.some((byte) => byte < 32 || byte === 127)) refuse("control character in a header");
  return value.toString("utf8");
}

interface Entry {
  name: string;
  type: number;
  size: number;
}

function readHeader(header: Buffer): Entry {
  const checksum = octal(header, 148, 8);
  const actual = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  if (checksum !== actual) refuse("header checksum mismatch");
  const magic = header.subarray(257, 265).toString("latin1");
  if (magic !== "ustar\0" + "00" && magic !== "ustar  \0") refuse("unsupported tar header");
  for (const [start, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
    [136, 12],
  ])
    octal(header, start, length);
  octal(header, 329, 8, true);
  octal(header, 337, 8, true);
  if (textField(header, 157, 100)) refuse("links are unsupported");
  const name = textField(header, 0, 100);
  const prefix = textField(header, 345, 155);
  if (!name) refuse("empty member name");
  return {
    name: prefix ? `${prefix}/${name}` : name,
    type: header[156],
    size: octal(header, 124, 12),
  };
}

/** Only timestamp metadata is supported. Path, size, and other semantic overrides are refused. */
function validatePax(body: Buffer): void {
  if (body.length === 0 || body.length > MAX_PAX) refuse("unsupported PAX metadata size");
  const keys = new Set<string>();
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(32, offset);
    if (space < 0) refuse("invalid PAX record length");
    const lengthText = body.subarray(offset, space).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(lengthText) || lengthText.includes("\n"))
      refuse("invalid PAX record length");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || end <= space + 1)
      refuse("incomplete PAX record");
    const record = body.subarray(space + 1, end);
    if (!isUtf8(record)) refuse("invalid PAX encoding");
    const match = /^(mtime|atime|ctime)=(-?[0-9]+(?:\.[0-9]+)?)\n$/.exec(record.toString("utf8"));
    if (!match || match[0].length !== record.length || keys.has(match[1]))
      refuse("unsupported or repeated PAX metadata");
    keys.add(match[1]);
    offset = end;
  }
}

function entryBody(tar: Buffer, offset: number, size: number): { body: Buffer; next: number } {
  const start = offset + BLOCK;
  const end = start + size;
  const next = start + Math.ceil(size / BLOCK) * BLOCK;
  if (next > tar.length) refuse("incomplete member body or padding");
  if (!isZero(tar.subarray(end, next))) refuse("nonzero member padding");
  return { body: tar.subarray(start, end), next };
}

interface ArchiveState {
  index?: Buffer;
  description: boolean;
  pendingPax: boolean;
}

function acceptRegular(state: ArchiveState, entry: Entry, body: Buffer): void {
  if (entry.type !== 0 && entry.type !== 48) refuse("unsupported member type");
  state.pendingPax = false;
  if (/^\.SIGN\.(RSA|RSA256|RSA512|DSA)\.[a-zA-Z0-9._+@-]+$/.test(entry.name)) {
    if (state.description || state.index !== undefined) refuse("signature after index content");
    if (body.length === 0) refuse("empty signature member");
    return;
  }
  if (entry.name === "DESCRIPTION" && !state.description && state.index === undefined) {
    state.description = true;
    return;
  }
  if (entry.name === "APKINDEX" && state.index === undefined) {
    state.index = body;
    return;
  }
  refuse(`unsupported or duplicate member: ${entry.name}`);
}

function finish(tar: Buffer, offset: number, state: ArchiveState): string {
  if (state.pendingPax) refuse("PAX metadata has no following member");
  if (tar.length - offset < 2 * BLOCK || !isZero(tar.subarray(offset)))
    refuse("incomplete terminator or data after terminator");
  if (state.index === undefined) refuse("no APKINDEX member");
  if (!isUtf8(state.index)) refuse("invalid UTF-8 in APKINDEX");
  return state.index.toString("utf8");
}

function inflateComplete(gz: Buffer, limit: number): Buffer {
  // Node's declarations omit the documented object result for info:true.
  const result: unknown = gunzipSync(gz, { maxOutputLength: limit, info: true });
  if (
    typeof result !== "object" ||
    result === null ||
    !("buffer" in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !("engine" in result)
  )
    refuse("gzip input accounting unavailable");
  const engine = result.engine;
  if (
    typeof engine !== "object" ||
    engine === null ||
    !("bytesWritten" in engine) ||
    engine.bytesWritten !== gz.length
  )
    refuse("unconsumed gzip input");
  return result.buffer;
}

/**
 * Read Alpine's supported index archive profile without extraction or code execution.
 * Validate the entire decompressed archive before return, including the two final zero blocks.
 * Leading signature fragments need no tar terminator. Signature bytes are not authenticated here.
 * The optional trusted caller limit can only reduce the 64 MiB cumulative decompression limit.
 */
export function apkIndexText(gz: Buffer, maxInflatedBytes = MAX_INFLATED): string {
  if (
    !Number.isSafeInteger(maxInflatedBytes) ||
    maxInflatedBytes <= 0 ||
    maxInflatedBytes > MAX_INFLATED
  )
    refuse("invalid decompression limit");
  if (gz.length > MAX_COMPRESSED) refuse("compressed input exceeds 16 MiB");
  const tar = inflateComplete(gz, maxInflatedBytes);
  if (tar.length % BLOCK !== 0) refuse("partial tar block");
  const state: ArchiveState = { description: false, pendingPax: false };
  let entries = 0;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZero(header)) return finish(tar, offset, state);
    if (++entries > MAX_ENTRIES) refuse("too many archive members");
    const entry = readHeader(header);
    const { body, next } = entryBody(tar, offset, entry.size);
    if (entry.type === 120) {
      if (state.pendingPax || state.index !== undefined) refuse("unexpected PAX metadata");
      validatePax(body);
      state.pendingPax = true;
    } else acceptRegular(state, entry, body);
    offset = next;
  }
  return refuse("missing tar terminator");
}
