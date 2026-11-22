const MAX_BYTES = 16 * 1024 * 1024;
const ATTEMPTS = 3;
const NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Fetch one fixed Alpine source. Exhausted or permanent failures reject. */
export type ApkFetcher = (url: string) => Promise<Buffer>;

class ApkFetchError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function networkCodes(error: unknown): string[] {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const codes = new Set<string>();
  while (queue.length && seen.size < 16) {
    const current = queue.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^[A-Z_]{2,40}$/.test(current.code)
    )
      codes.add(current.code);
    queue.push(current.cause);
    if (current instanceof AggregateError) queue.push(...current.errors.slice(0, 16));
  }
  return [...codes].sort();
}

function canRetry(error: unknown): boolean {
  if (error instanceof ApkFetchError) return error.retryable;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const codes = networkCodes(error);
  return codes.length > 0 && codes.every((code) => NETWORK_CODES.has(code));
}

async function rejectBody(cancel: () => Promise<void>, reason: unknown): Promise<never> {
  const error =
    reason instanceof Error ? reason : new Error("Alpine source read failed", { cause: reason });
  try {
    await cancel();
  } catch (cleanupError) {
    if (cleanupError !== error)
      error.cause = new AggregateError(
        [error.cause, cleanupError],
        "Response cancellation also failed",
      );
  }
  throw error;
}

async function rejectResponse(response: Response, error: Error): Promise<never> {
  return rejectBody(() => response.body?.cancel() ?? Promise.resolve(), error);
}

async function readBody(response: Response): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    return rejectResponse(
      response,
      new ApkFetchError(`Alpine source exceeds ${MAX_BYTES} bytes or has an invalid length`),
    );
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new ApkFetchError(`Alpine source exceeds ${MAX_BYTES} bytes`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    return await rejectBody(() => reader.cancel(), error);
  } finally {
    reader.releaseLock();
  }
}

async function fetchOnce(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (response.status !== 200) {
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599);
    return rejectResponse(
      response,
      new ApkFetchError(`HTTP ${response.status} from Alpine source`, retryable),
    );
  }
  if (response.headers.has("content-range"))
    return rejectResponse(response, new ApkFetchError("Partial Alpine response has Content-Range"));
  return readBody(response);
}

function sourceUrl(value: string): void {
  const url = new URL(value);
  const allowed = ["https://secdb.alpinelinux.org", "https://dl-cdn.alpinelinux.org"];
  if (!allowed.includes(url.origin) || url.username || url.password || url.hash)
    throw new ApkFetchError("Expected an HTTPS Alpine source without credentials or a fragment");
}

/** Retry transient source failures; preserve TLS, redirect, status, timeout, and byte limits. */
export const defaultApkFetcher: ApkFetcher = async (url) => {
  sourceUrl(url);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      if (!canRetry(error) || attempt === ATTEMPTS) {
        const message = error instanceof Error ? error.message : "Unknown source failure";
        const codes = networkCodes(error);
        const detail = codes.length ? ` [${codes.join(", ")}]` : "";
        const unit = attempt === 1 ? "attempt" : "attempts";
        throw new Error(`Alpine fetch failed after ${attempt} ${unit}: ${message}${detail}`, {
          cause: error,
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
};
