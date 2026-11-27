/**
 * Where a failure that "must make kit exit non-zero" lands.
 *
 * On the CLI there is one command per process, so such a failure is `process.exitCode = 1`. In a
 * long-running server (the MCP server) one tool call is not the process: setting `exitCode` there
 * would mark every later call's process exit as failed, and the call that failed would not say so.
 * A server runs each call inside `runInCallScope`; inside a scope, `failCall` records the failure
 * on that call alone (the caller turns it into the call's error) and leaves `process.exitCode`
 * untouched. Scopes are per async context, so concurrent calls do not see each other's failures.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface CallScope {
  failures: string[];
}

const scope = new AsyncLocalStorage<CallScope>();

/** Record a failure: on the current call when inside a scope, else on the process exit code. */
export function failCall(reason: string): void {
  const s = scope.getStore();
  if (s) s.failures.push(reason);
  else process.exitCode = 1;
}

/** Run `fn` as one call. Returns its value and the failures recorded on it, in order. */
export async function runInCallScope<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; failures: string[] }> {
  const s: CallScope = { failures: [] };
  const value = await scope.run(s, fn);
  return { value, failures: s.failures };
}
