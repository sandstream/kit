/**
 * Binary artifacts inside a package tarball, recognised by their first bytes.
 *
 * An npm package is expected to hold JavaScript and data. A native executable, a boot
 * image or a compiled module inside it is something only the publisher can rebuild, so
 * triage names it: path, kind and size. It is a fact, never a verdict: many legitimate
 * packages ship prebuilt addons (`.node` files are ELF, PE or Mach-O) or WebAssembly.
 *
 * Detection reads at most `HEAD_BYTES` from each file and never runs anything.
 */
import { open } from "node:fs/promises";

export const HEAD_BYTES = 4096;

export interface BinaryKind {
  kind: string;
  severity: "info" | "warn";
}

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function u32le(b: Uint8Array, at: number): number {
  return ((b[at + 3] << 24) | (b[at + 2] << 16) | (b[at + 1] << 8) | b[at]) >>> 0;
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** A Windows PE file: `MZ`, and the `e_lfanew` offset at 0x3c points at `PE\0\0`. */
function isPe(b: Uint8Array): boolean {
  if (!ascii(b, 0, "MZ") || b.length < 0x40) return false;
  const pe = u32le(b, 0x3c);
  return pe + 4 <= b.length && ascii(b, pe, "PE\0\0");
}

/** `0xCAFEBABE` is both a Mach-O universal binary and a Java class; a small arch count means Mach-O. */
function cafebabe(b: Uint8Array): BinaryKind {
  const archs = u32be(b, 4);
  return archs > 0 && archs < 32
    ? { kind: "Mach-O universal executable", severity: "warn" }
    : { kind: "Java class file", severity: "warn" };
}

/** The kind of binary `head` starts with, or null for text and unrecognised data. */
export function binaryKind(head: Uint8Array): BinaryKind | null {
  if (head.length < 4) return null;
  // A Linux x86 boot image carries "HdrS" at 0x202 (boot protocol header).
  if (ascii(head, 0x202, "HdrS")) return { kind: "Linux kernel boot image", severity: "warn" };
  if (ascii(head, 0, "\x7fELF")) return { kind: "ELF executable or library", severity: "warn" };
  const magic = u32be(head, 0);
  if (MACHO.has(magic)) return { kind: "Mach-O executable or library", severity: "warn" };
  if (magic === 0xcafebabe && head.length >= 8) return cafebabe(head);
  if (isPe(head)) return { kind: "Windows PE executable or library", severity: "warn" };
  if (ascii(head, 0, "\0asm")) return { kind: "WebAssembly module", severity: "info" };
  return null;
}

/** Read up to `HEAD_BYTES` of `path` and classify it. Null when unreadable or not binary. */
export async function sniffBinary(path: string): Promise<BinaryKind | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return binaryKind(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
