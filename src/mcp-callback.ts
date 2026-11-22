/**
 * `kit mcp callback`: finish an OAuth sign-in whose callback page cannot load.
 *
 * A CLI or an agent on a remote machine starts a sign-in and listens on loopback there. The browser
 * is on another machine, so after approval it lands on `http://localhost:<port>/callback?code=…`
 * and shows an error. The person copies that address; this command checks it and requests it on
 * the machine where the listener is (kit-research `t3code-mcp-sign-in-vs-kit`, after T3 Code's
 * `oauthCallback.ts`).
 *
 * Checks, all on the pasted address:
 *   - at most 16,384 characters, no username, password or fragment;
 *   - exactly one `state`, and exactly one `code` or exactly one `error`;
 *   - a loopback host (`localhost`, `127.0.0.1`, `[::1]`): kit never requests another host;
 *   - with `--for <authorization URL>`: the same origin and path as its `redirect_uri`, and its
 *     `state`. Without `--for` the binding to a sign-in is not checked, and the output says so.
 *
 * One GET, redirects not followed, ten seconds. kit prints the host and the HTTP status, never the
 * address, and stores nothing: the tool that started the sign-in keeps the credential. The gates
 * refuse this command from an agent's shell tool, so the code does not pass through a model.
 */
const MAX_LENGTH = 16_384;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TIMEOUT_MS = 10_000;

/** A URL copied from an address bar, which can hide its `http://`. Throws if it is not one. */
function pastedUrl(value: string, protocol = "http:"): URL {
  const pasted = value.trim();
  return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(pasted) ? pasted : `${protocol}//${pasted}`);
}

export type CallbackCheck =
  { ok: true; url: URL; bound: boolean; outcome: "code" | "error" } | { ok: false; why: string };

function expectedFrom(authorizationUrl: string): { redirect: URL; state: string } | string {
  let params: URLSearchParams;
  try {
    params = new URL(authorizationUrl.trim()).searchParams;
  } catch {
    return "--for is not a URL: pass the sign-in page's address";
  }
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state");
  if (!redirectUri || !state) return "--for has no redirect_uri and state to check against";
  try {
    return { redirect: new URL(redirectUri), state };
  } catch {
    return "--for carries a redirect_uri that is not a URL";
  }
}

function single(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  return all.length === 1 && all[0] ? all[0] : null;
}

/** The state and outcome of a callback address, or why its shape is not one. Pure. */
function callbackShape(url: URL): { state: string; outcome: "code" | "error" } | string {
  if (url.username || url.password || url.hash) {
    return "the address carries a username, password or fragment";
  }
  const state = single(url, "state");
  if (!state) return "the address does not carry exactly one state";
  const codes = url.searchParams.getAll("code").length;
  const errors = url.searchParams.getAll("error").length;
  if (single(url, "code") && errors === 0) return { state, outcome: "code" };
  if (single(url, "error") && codes === 0) return { state, outcome: "error" };
  return "the address does not carry exactly one code or exactly one error";
}

/** Whether a pasted address is a deliverable OAuth callback. Pure: no request is made. */
export function checkCallback(pasted: string, authorizationUrl?: string): CallbackCheck {
  if (pasted.length > MAX_LENGTH) return { ok: false, why: "the address is too long" };
  let expected: { redirect: URL; state: string } | undefined;
  if (authorizationUrl !== undefined) {
    const e = expectedFrom(authorizationUrl);
    if (typeof e === "string") return { ok: false, why: e };
    expected = e;
  }
  let url: URL;
  try {
    url = pastedUrl(pasted, expected?.redirect.protocol);
  } catch {
    return { ok: false, why: "that is not an address: paste the whole address from the browser" };
  }
  const shape = callbackShape(url);
  if (typeof shape === "string") return { ok: false, why: shape };
  const { state, outcome } = shape;
  if (!LOOPBACK.has(url.hostname)) {
    return {
      ok: false,
      why: `the callback host is ${url.host}, not this machine: finish the sign-in in a browser that can reach it`,
    };
  }
  if (expected) {
    const sameTarget =
      url.origin === expected.redirect.origin && url.pathname === expected.redirect.pathname;
    if (!sameTarget || state !== expected.state) {
      return { ok: false, why: "the address does not belong to the sign-in given with --for" };
    }
  }
  return { ok: true, url, bound: expected !== undefined, outcome };
}

export interface Delivery {
  delivered: boolean;
  /** HTTP status of the listener's answer, when it answered. */
  status?: number;
}

/** One GET to the loopback listener. Redirects are not followed. Never throws. */
export async function deliverCallback(url: URL, timeoutMs = TIMEOUT_MS): Promise<Delivery> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return { delivered: true, status: res.status };
  } catch {
    return { delivered: false };
  }
}

async function readAddress(arg: string | undefined): Promise<string> {
  if (arg && arg !== "-") return arg;
  if (process.stdin.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question("Address of the page your browser opened: ")).trim();
    } finally {
      rl.close();
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** `kit mcp callback [--for <authorization URL>] [<address> | -]`. Prints no address. */
export async function cmdMcpCallback(args: string[]): Promise<boolean> {
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    console.error("kit mcp callback: refused in read-only mode (it makes a request)");
    return false;
  }
  const { flagValue } = await import("./utils/flags.js");
  const forAt = args.indexOf("--for");
  const authorizationUrl = forAt === -1 ? undefined : (flagValue(args, "--for") ?? undefined);
  if (forAt !== -1 && !authorizationUrl) {
    console.error("kit mcp callback: --for needs the sign-in page's address");
    return false;
  }
  const rest = args.filter((a, i) => i !== forAt && i !== forAt + 1);
  const pasted = await readAddress(rest.find((a) => a === "-" || !a.startsWith("-")));
  if (!pasted) {
    console.error("Usage: kit mcp callback [--for <authorization URL>] [<address> | -]");
    return false;
  }
  const check = checkCallback(pasted, authorizationUrl);
  if (!check.ok) {
    console.error(`kit mcp callback: not delivered: ${check.why}`);
    return false;
  }
  if (!check.bound) {
    console.error(
      "kit mcp callback: no --for given, so whether this address belongs to your sign-in was not checked",
    );
  }
  const result = await deliverCallback(check.url);
  if (!result.delivered) {
    console.error(
      `kit mcp callback: nothing answered on ${check.url.host}. The listener may have closed: check the tool that started the sign-in, or start again`,
    );
    return false;
  }
  const what = check.outcome === "code" ? "sign-in callback" : "sign-in error";
  console.log(
    `kit mcp callback: delivered the ${what} to ${check.url.host} (HTTP ${result.status}). Check the tool that started the sign-in.`,
  );
  return true;
}
