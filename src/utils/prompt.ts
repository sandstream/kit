/**
 * Prompt the user for Y/n confirmation.
 *
 * On no-TTY (piped / CI) and on timeout the result is `defaultValue`. It
 * defaults to `true` (auto-yes) to preserve the historical "[Y/n] auto-yes"
 * behavior. DESTRUCTIVE/irreversible confirmations MUST pass
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
  // Return the default when stdin is not a terminal.
  if (!process.stdin.isTTY) return defaultValue;

  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (data: string) => {
      const answer = data.toString().trim().toLowerCase();
      finish(answer === "" ? defaultValue : answer === "y" || answer === "yes");
    };
    const onEnd = () => finish(defaultValue);
    const timer = setTimeout(() => {
      process.stdout.write("\n");
      finish(defaultValue);
    }, timeoutMs);

    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
  });
}
