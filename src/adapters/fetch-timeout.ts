/**
 * Upper bound for one vendor API call made by a provisioning adapter.
 *
 * A stalled endpoint must fail `kit add` with an error, not hang it. 15 s is
 * the value kit's other vendor REST calls use (`pkg-triage.ts`, `triage-go.ts`,
 * `secrets-propagate-vercel.ts`, `review-gate-github.ts`), passed the same way:
 * `signal: AbortSignal.timeout(...)`.
 */
const ADAPTER_FETCH_TIMEOUT_MS = 15_000;

/** `fetch` with the adapter timeout. A caller's own `signal` is not supported: none passes one. */
export function adapterFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ADAPTER_FETCH_TIMEOUT_MS) });
}
