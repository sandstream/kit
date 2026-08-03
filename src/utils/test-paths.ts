/**
 * One definition of "this path is a test or fixture", shared by every secret-scan
 * surface.
 *
 * It exists because the surfaces disagreed. `check-security.ts`'s repo-wide grep
 * deliberately drops test/fixture hits — fake credentials live there by design, and the
 * authoritative scanners (trufflehog locally, gitleaks in CI) still scan them, so
 * suppressing them in the *unverified* stopgap de-noises without weakening the real
 * gate. `scan-staged.ts`, the pre-commit gate, had no such rule, so kit's own audit
 * **redaction** test — which must contain secret-shaped input to prove the redaction
 * works — blocked the commit that added it.
 *
 * A developer's only escape from that is `git commit --no-verify`, which disables the
 * whole hook. Training people to bypass a gate is how gates die, so the shape of the
 * fix matters: a test-path hit is reported as an ADVISORY rather than dropped, and only
 * a hit outside test paths blocks.
 *
 * Pure, no I/O.
 */

/**
 * Path segments that mark a file as test or fixture material: a `.test.`/`.spec.`
 * filename, a `__tests__`/`__mocks__` directory, a `fixture`/`fixtures` directory, or a
 * `.fixture.` filename. Deliberately narrow — a directory merely *named* something like
 * `testing-utils` is real code and must keep blocking.
 */
const TEST_PATH_RE = /(\.test\.|\.spec\.|__tests__|\/__mocks__\/|\/fixtures?\/|\.fixture\.)/;

/** True when `path` is test or fixture material, where fake credentials are expected. */
export function isTestOrFixturePath(path: string): boolean {
  // Normalise Windows separators so the directory alternatives match on either OS.
  return TEST_PATH_RE.test(path.replace(/\\/g, "/"));
}
