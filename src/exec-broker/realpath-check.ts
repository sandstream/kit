/**
 * Symlink-aware fs-write check — the IMPURE companion to the pure `decisions.checkFsWrite`.
 *
 * `checkFsWrite` is a pure string/traversal gate and, by design, cannot follow symlinks: a
 * symlink INSIDE the signed root that points outside would pass the string check yet write
 * outside. This closes that hole by resolving real paths at the actual filesystem. It lives in
 * its own module (not in the pure `decisions.ts`) so BOTH the exec-broker runtime (`broker.ts`)
 * and the PreToolUse `gate-fs` (`commands/gate.ts`) call ONE source of truth — the enforcement
 * point must never be weaker than the broker it mirrors.
 *
 * Realpath the nearest EXISTING ancestor of the resolved target and confirm it is the real root
 * or strictly under it. The not-yet-existing tail cannot contain symlinks (nothing is there to
 * be one). Any fs/realpath error → fail-closed deny.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function checkFsWriteRealpath(
  path: string,
  projectRoot: string,
): { ok: boolean; reason?: string } {
  try {
    const root = realpathSync(resolve(projectRoot));
    let cur = resolve(root, path);
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break; // reached the filesystem root
      cur = parent;
    }
    const real = realpathSync(cur);
    if (real === root || real.startsWith(root + sep)) return { ok: true };
    return { ok: false, reason: `fs-write: real path ${real} escapes root ${root}` };
  } catch {
    return { ok: false, reason: "fs-write: realpath check failed (fail-closed)" };
  }
}
