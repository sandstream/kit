import type * as readline from "node:readline/promises";

/**
 * Ask one readline question and answer `null` when nobody answered.
 *
 * Two different things end a question without an answer, and both used to end the whole
 * command on a node stack trace at the moment the user tried to back out:
 *
 * - **Ctrl+D at a terminal** — readline rejects the question with an `AbortError`.
 * - **The input closing** — a pipe that ended, a terminal that went away. Here the promise
 *   from `rl.question` simply never settles, so the command hangs instead of crashing.
 *
 * Both are the same statement — "no answer" — so both come back as `null` and the caller
 * decides what that means. The close case is a race rather than a catch because a pending
 * promise cannot be caught; resolving it is the only way out.
 *
 * Shared by `promptSelect` and `promptMultiSelect` on purpose: two copies of this rule would
 * drift, and the drift would be one prompt crashing where its sibling recovers.
 */
export async function askQuestion(rl: readline.Interface, prompt: string): Promise<string | null> {
  try {
    return await new Promise<string | null>((resolve, reject) => {
      rl.once("close", () => resolve(null));
      rl.question(prompt).then(resolve, reject);
    });
  } catch {
    return null; // AbortError from Ctrl+D, or any other rejection: still just "no answer".
  }
}
