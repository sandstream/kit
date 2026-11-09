/**
 * Fetch a release asset into memory, and try again when the failure is one a second
 * try can fix: a network error, a timeout, HTTP 408, 429 or any 5xx. An answer such as
 * 404 or 403 will not change, so it is not retried. A redirect off HTTPS is refused at
 * once. The caller still checks the bytes against a pinned checksum, so a retry never
 * widens what is trusted.
 *
 * This came from a CI run where github.com answered 504 for a release asset and the
 * required scanner download failed the whole security gate for a reason outside the change.
 */

export interface FetchWithRetryOptions {
  /** Network timeout for ONE attempt, ms. */
  timeoutMs: number;
  /** Total attempts, first one included. Default 4. */
  attempts?: number;
  /** Wait before attempt n+1 (n starts at 1), ms. Default 2s, 4s, 8s. */
  delayMs?: (attempt: number) => number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

/** Raised for an answer a retry cannot change. */
class PermanentFetchError extends Error {}

async function attemptOnce(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      const message = `HTTP ${res.status} fetching ${url}`;
      throw RETRYABLE_STATUS(res.status) ? new Error(message) : new PermanentFetchError(message);
    }
    // The checksum is what proves integrity, but refuse a redirect that left HTTPS.
    if (!res.url.startsWith("https:")) {
      throw new PermanentFetchError(`refusing non-https download URL after redirects: ${res.url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions): Promise<Buffer> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const delayMs = opts.delayMs ?? ((n: number) => 2000 * 2 ** (n - 1));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await attemptOnce(url, opts.timeoutMs, fetchImpl);
    } catch (err) {
      if (err instanceof PermanentFetchError) throw err;
      last = err;
      if (attempt < attempts) await sleep(delayMs(attempt));
    }
  }
  const reason = last instanceof Error ? last.message : String(last);
  throw new Error(`${reason} (after ${attempts} attempts)`);
}
