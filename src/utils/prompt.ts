/**
 * Prompt the user for Y/n confirmation.
 *
 * On no-TTY (piped / CI) and on timeout the result is `defaultValue`. It
 * defaults to `true` (auto-yes) to preserve the historical "[Y/n] auto-yes"
 * behavior — but DESTRUCTIVE/irreversible confirmations MUST pass
 * `defaultValue = false` so a walk-away or a piped invocation fails closed
 * (e.g. the jwt-secret-roll "auto-no in 15s" cutover).
 *
 * Extracted from cli.ts so command modules (secrets-rotate-cli etc.)
 * can use it without a circular import back into the CLI entry point.
 */
export async function promptConfirm(
  prompt: string,
  timeoutMs = 5000,
  defaultValue = true,
): Promise<boolean> {
  // Skip prompt when stdin is not a TTY (piped / CI) — fall back to the default.
  if (!process.stdin.isTTY) return defaultValue;

  return new Promise((resolve) => {
    process.stdout.write(prompt);

    const timer = setTimeout(() => {
      process.stdout.write("\n");
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      resolve(defaultValue);
    }, timeoutMs);

    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (data: string) => {
      clearTimeout(timer);
      process.stdin.pause();
      const answer = data.toString().trim().toLowerCase();
      resolve(answer !== "n" && answer !== "no");
    });
  });
}
