/**
 * The JSON payload a harness writes to a lifecycle hook's stdin (Claude Code and Codex both send
 * one). A hook must never hold up the session, so the read is bounded in time and in bytes, skips
 * a TTY (a manual `kit memory hook …` in a terminal), and happens once per process: stdin can be
 * consumed only once, and more than one part of a hook wants the payload.
 */

/** Payloads above this are not parsed. A UserPromptSubmit payload carries the whole prompt. */
const HOOK_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

export type HookPayload = Record<string, unknown>;

let pending: Promise<HookPayload | undefined> | undefined;

function readBounded(timeoutMs: number, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (overflow = false) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      process.stdin.destroy();
      resolve(overflow ? undefined : Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    process.stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) return finish(true);
      chunks.push(c);
    });
    process.stdin.once("end", () => finish());
    process.stdin.once("error", () => finish());
  });
}

function parseObject(raw: string | undefined): HookPayload | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as HookPayload)
      : undefined;
  } catch {
    return undefined; // not JSON: no payload
  }
}

/**
 * This process's hook payload, or undefined when stdin is a TTY, empty, not a JSON object, larger
 * than `maxBytes`, or still open after `timeoutMs`. The first call reads; later calls share it.
 */
export function readHookPayload(
  timeoutMs = 400,
  maxBytes = HOOK_PAYLOAD_MAX_BYTES,
): Promise<HookPayload | undefined> {
  if (!pending) {
    pending = process.stdin.isTTY
      ? Promise.resolve(undefined)
      : readBounded(timeoutMs, maxBytes).then(parseObject);
  }
  return pending;
}

/**
 * Whether a UserPromptSubmit payload is a prompt the user sent. Claude Code marks it with
 * `source: "user"`; other sources (`poll_event`: output of background code in Code Mode) are not
 * the user. A payload with no `source` (an older harness, Codex, no payload) counts as the user's,
 * so the hook behaves as it did before the field existed.
 */
export function promptFromUser(payload: HookPayload | undefined): boolean {
  const source = payload?.source;
  return typeof source !== "string" || source === "user";
}
