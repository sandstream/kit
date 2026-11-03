/**
 * `kit worktree-gates`: run by the post-checkout hook that `kit agent-config` installs. One quiet line
 * when it installs the gates (or fails to), nothing otherwise, so an ordinary git checkout stays silent.
 * False only on a failed install.
 */
import { ensureWorktreeGates } from "../worktree-gates.js";

export async function cmdWorktreeGates(): Promise<boolean> {
  const got = await ensureWorktreeGates();
  if (got.outcome === "installed" || got.outcome === "failed") {
    console.log(`kit: worktree gates: ${got.detail}`);
  }
  return got.outcome !== "failed";
}
