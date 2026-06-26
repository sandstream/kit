/**
 * Shared hex-key file reader with a length guard + bounded retry.
 *
 * Machine-local HMAC keys (audit anchor, elevation) are created atomically with
 * `flag: "wx"`. The loser of a create race must re-read the winner's file, but a
 * naive single read can land MID-WRITE and return a partial (or empty) string.
 * A zero/short key silently breaks every later HMAC compare (false tip-mismatch
 * / refused elevation), so the re-read MUST enforce the same `hex.length >=
 * minHexLen` guard the happy path uses, and retry briefly while the winner
 * finishes its write.
 *
 * This NEVER returns a short/empty key: it either returns a full-length key or
 * throws with a clear reason (no silent degrade).
 */
import { readFile } from "node:fs/promises";

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Re-read a hex key file, retrying with a small linear backoff until it holds at
 * least `minHexLen` hex chars. Throws if it never does (e.g. the file stays
 * truncated/absent) rather than handing back a zero-length key.
 */
export async function reReadHexKey(path: string, minHexLen = 64, attempts = 5): Promise<Buffer> {
  let lastLen = -1;
  for (let i = 0; i < attempts; i++) {
    try {
      const hex = (await readFile(path, "utf-8")).trim();
      if (hex.length >= minHexLen) return Buffer.from(hex, "hex");
      lastLen = hex.length;
    } catch {
      // Not yet visible (mid-write / not flushed) - fall through to backoff.
      lastLen = -1;
    }
    if (i < attempts - 1) await delay(15 * (i + 1));
  }
  throw new Error(
    `key file ${path} did not become readable with >=${minHexLen} hex chars after ${attempts} attempts (last observed length ${lastLen})`,
  );
}
