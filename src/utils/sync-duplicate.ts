/**
 * Cloud-sync duplicate detection for build output.
 *
 * A repo that lives in iCloud Drive / Dropbox / OneDrive gets a second copy of a file
 * whenever the syncer sees two versions it can't reconcile — `foo.js` gains `foo 2.js`,
 * `foo.test.js` gains `foo 2.test.js`, plus the `… copy.js` variants. In build output
 * that is not cosmetic: the test runner discovers `*.test.js` by name, so a stale
 * duplicate runs OLD assertions against NEW code. It can fail a correct change, and —
 * worse — pass a broken one, because a duplicate of a since-deleted test still runs.
 *
 * Bit once for real: `dist/check-security 2.test.js` failed on expectations the source
 * no longer holds, which reads as a code regression. Hence the gate in
 * `scripts/test.mjs`, which refuses to run rather than report a verdict it can't trust.
 */

/**
 * True when a file name is a cloud-sync duplicate rather than a real artifact.
 *
 * Matches the two shapes syncers actually produce — ` <n>.` and ` copy[ <n>].` directly
 * before the extension. The counter is capped at two digits on purpose: sync copies
 * count small, so a legitimate `sha2 256.js` stays a real file. Pure and platform-agnostic
 * (pass a basename, not a path).
 */
export function isSyncDuplicateName(name: string): boolean {
  return /(?: copy(?: \d{1,2})?| \d{1,2})\.[^.\s]+(?:\.[^.\s]+)*$/.test(name);
}
