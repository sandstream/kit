/**
 * Electron's `app.asar`, scanned as bytes.
 *
 * `kit security scan-build` exists because what ships is readable, and a model will take apart
 * any Electron app (kit-research `thomas-wolf-future-of-software-vs-kit`). But it read only text
 * extensions, so a key inside `dist/linux-unpacked/resources/app.asar` passed with a green line.
 *
 * An asar is a JSON header followed by the packed files, concatenated and uncompressed, so the
 * credential shapes can be matched on the raw bytes with no extractor and no dependency. An asar
 * is often far over the 5 MiB text-file budget, so it is read in windows that overlap by more
 * than any credential shape is long.
 */
import { open } from "node:fs/promises";
import type { SecretFinding } from "./utils/redactSecrets.js";
import { archiveEvidenceSchema, type ArchiveEvidence } from "./finding-evidence.js";
import { findBuildMatches } from "./scan-build-sourcemap.js";

export type ArchiveSecret = SecretFinding & { evidence: ArchiveEvidence };

/** Larger than this, the asar is reported as not scanned rather than read. */
const MAX_ASAR_BYTES = 1024 * 1024 * 1024; // 1 GiB
const WINDOW = 4 * 1024 * 1024;
/** Longer than any shape kit matches, a 4096-bit PEM private key included. */
const OVERLAP = 64 * 1024;

/**
 * The credential findings in one asar, or "too-large". `latin1` maps each byte to one character,
 * so an ASCII credential reads the same whatever surrounds it. Findings repeated by the overlap
 * are reported once.
 */
export async function findAsarSecrets(
  path: string,
  rel: string,
  opts: { window?: number; overlap?: number } = {},
): Promise<ArchiveSecret[] | "too-large"> {
  const window = opts.window ?? WINDOW;
  const overlap = opts.overlap ?? OVERLAP;
  // One descriptor for both the size and the reads, so the file checked is the file read.
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_ASAR_BYTES) return "too-large";
    const seen = new Set<string>();
    const findings: ArchiveSecret[] = [];
    const buffer = Buffer.alloc(window);
    for (let pos = 0; pos < size; pos += window - overlap) {
      const { bytesRead } = await handle.read(buffer, 0, window, pos);
      if (bytesRead === 0) break;
      const text = buffer.subarray(0, bytesRead).toString("latin1");
      for (const { label, preview, offset } of findBuildMatches(text)) {
        const id = `${label}\0${preview}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const evidence = archiveEvidenceSchema.parse({
          file: rel,
          byteOffset: pos + offset,
          pattern: label,
        });
        findings.push({ label, preview, evidence });
      }
      if (pos + bytesRead >= size) break;
    }
    return findings;
  } finally {
    await handle.close();
  }
}
