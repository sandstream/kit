/**
 * Cost monitoring for the spend-cap policy declared in
 * `.kit-allowlist.json` (see security-policy.ts).
 *
 * v1 scope: provider adapters that have a stable public usage / balance API
 * accessible via the same key already in the env. Anything that requires
 * paid analytics endpoints (Stripe Sigma) or a billing-dashboard scrape is
 * out of scope — we don't want kit to need a separate API.
 *
 * Concretely supported today:
 *   - Stripe: `GET /v1/balance` (live + pending balance, all currencies)
 *
 * Stubbed (returns "not implemented" until a public API exists):
 *   - OpenAI / Anthropic — usage endpoints require dashboard scraping
 *   - Resend — no usage API
 *   - Vercel — usage endpoint exists but rate-limited per-account
 */

export interface CostSample {
  provider: string;
  /** Logical key the policy is attached to (e.g. STRIPE_SECRET_KEY) */
  policyKey: string;
  /** Current usage / balance figure */
  current: number;
  unit: "usd" | "eur" | "sek" | "tokens" | "requests";
  /** Spend cap from policy, if declared */
  capUsd?: number;
  /** Plain-text status string suitable for table display */
  status: "ok" | "warn" | "over-cap" | "no-cap" | "no-api" | "auth-failed" | "skipped";
  detail: string;
}

type ProviderAdapter = (key: string, opts: { capUsd?: number }) => Promise<CostSample>;

async function stripeAdapter(key: string, opts: { capUsd?: number }): Promise<CostSample> {
  // `https://api.stripe.com/v1/balance` returns `{ available: [{amount, currency}], pending: [...] }`.
  // Amounts are in the currency's smallest unit (cents). We sum availability
  // across currencies and surface it as the dominant currency for clarity.
  try {
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      return {
        provider: "stripe",
        policyKey: "STRIPE_SECRET_KEY",
        current: 0,
        unit: "usd",
        capUsd: opts.capUsd,
        status: "auth-failed",
        detail: "Stripe key not authorized (rotate / re-check restricted scopes)",
      };
    }
    if (!res.ok) {
      return {
        provider: "stripe",
        policyKey: "STRIPE_SECRET_KEY",
        current: 0,
        unit: "usd",
        capUsd: opts.capUsd,
        status: "no-api",
        detail: `Stripe /v1/balance returned ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      available: { amount: number; currency: string }[];
      pending: { amount: number; currency: string }[];
    };
    const sumCents = [...data.available, ...data.pending].reduce((sum, b) => sum + b.amount, 0);
    const usd = sumCents / 100;
    const cap = opts.capUsd;
    const status =
      cap === undefined ? "no-cap" : usd > cap ? "over-cap" : usd > cap * 0.8 ? "warn" : "ok";
    return {
      provider: "stripe",
      policyKey: "STRIPE_SECRET_KEY",
      current: usd,
      unit: "usd",
      capUsd: cap,
      status,
      detail: `available + pending across all currencies, converted at 1:1 (kit doesn't FX)`,
    };
  } catch (err: unknown) {
    return {
      provider: "stripe",
      policyKey: "STRIPE_SECRET_KEY",
      current: 0,
      unit: "usd",
      capUsd: opts.capUsd,
      status: "no-api",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const STUB_PROVIDERS: Record<string, { envKey: string; reason: string }> = {
  OPENAI_API_KEY: {
    envKey: "OPENAI_API_KEY",
    reason: "OpenAI usage endpoint requires dashboard auth; no key-bearable API yet",
  },
  ANTHROPIC_API_KEY: {
    envKey: "ANTHROPIC_API_KEY",
    reason: "Anthropic billing API is dashboard-only",
  },
  RESEND_API_KEY: {
    envKey: "RESEND_API_KEY",
    reason: "Resend exposes send-counts in the dashboard, not via key auth",
  },
  VERCEL_API_TOKEN: {
    envKey: "VERCEL_API_TOKEN",
    reason: "Vercel usage endpoint requires team-id + rate-limited",
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = {
  STRIPE_SECRET_KEY: stripeAdapter,
};

export async function sampleCosts(opts: {
  /** Per-key spend cap from policy, keyed by env-var name. */
  caps: Record<string, number | undefined>;
  /** Allow injection (used in tests) instead of reading process.env. */
  env?: Record<string, string | undefined>;
}): Promise<CostSample[]> {
  const env = opts.env ?? process.env;
  const samples: CostSample[] = [];

  for (const [keyName, adapter] of Object.entries(ADAPTERS)) {
    const value = env[keyName];
    if (!value) continue;
    samples.push(await adapter(value, { capUsd: opts.caps[keyName] }));
  }

  for (const [keyName, info] of Object.entries(STUB_PROVIDERS)) {
    const value = env[info.envKey];
    if (!value) continue;
    samples.push({
      provider: keyName.replace("_API_KEY", "").toLowerCase(),
      policyKey: keyName,
      current: 0,
      unit: "usd",
      capUsd: opts.caps[keyName],
      status: "no-api",
      detail: info.reason,
    });
  }

  return samples;
}

// ── Anomaly detection (P3.1 leak-detection layer) ──────────────────────────
//
// kit's existing cost-monitor surfaces CURRENT balance. For leak detection
// we need a BASELINE and a sliding window: a key that suddenly burns 3× its
// usual spend is the signal that matters. Baseline is stored locally
// (.kit-cost-baseline.json) and refreshed on a rolling window.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE_FILE = ".kit-cost-baseline.json";

export interface CostBaseline {
  /** Provider key (e.g. STRIPE_SECRET_KEY). */
  policyKey: string;
  /** Average daily spend over the last N samples. */
  avgDailyUsd: number;
  /** Most recent observation. */
  lastSampleUsd: number;
  /** When last updated (ISO). */
  updatedAt: string;
  /** Number of samples contributing to avgDailyUsd. */
  sampleCount: number;
}

export interface AnomalyAlert {
  policyKey: string;
  provider: string;
  currentUsd: number;
  baselineUsd: number;
  multiplier: number;
  severity: "info" | "warn" | "critical";
  detail: string;
}

async function loadBaselines(cwd: string): Promise<Record<string, CostBaseline>> {
  try {
    const raw = await readFile(resolve(cwd, BASELINE_FILE), "utf-8");
    return JSON.parse(raw) as Record<string, CostBaseline>;
  } catch {
    return {};
  }
}

async function saveBaselines(cwd: string, baselines: Record<string, CostBaseline>): Promise<void> {
  await writeFile(resolve(cwd, BASELINE_FILE), JSON.stringify(baselines, null, 2) + "\n", "utf-8");
}

/**
 * Update the rolling baseline for a sample. Simple exponential-moving-average
 * with weight 0.2 on the new sample so a single spike doesn't anchor the
 * baseline; instead, sustained-high readings raise the floor over time.
 */
function updateBaseline(prev: CostBaseline | undefined, sample: CostSample): CostBaseline {
  const weight = 0.2;
  const prevAvg = prev?.avgDailyUsd ?? sample.current;
  const newAvg = prev ? prevAvg * (1 - weight) + sample.current * weight : sample.current;
  return {
    policyKey: sample.policyKey,
    avgDailyUsd: newAvg,
    lastSampleUsd: sample.current,
    updatedAt: new Date().toISOString(),
    sampleCount: (prev?.sampleCount ?? 0) + 1,
  };
}

/**
 * Compare new samples against stored baselines. Returns alerts for any
 * provider whose current reading exceeds the baseline by a configurable
 * multiplier. Updates baselines in place so subsequent calls see the new
 * average.
 *
 *   warn  ≥ 2× baseline
 *   critical ≥ 4× baseline OR > 1.5× capUsd if a cap is declared
 */
export async function detectCostAnomalies(
  samples: CostSample[],
  opts: {
    cwd?: string;
    warnMultiplier?: number;
    criticalMultiplier?: number;
    persist?: boolean;
  } = {},
): Promise<AnomalyAlert[]> {
  const cwd = opts.cwd ?? process.cwd();
  const warnX = opts.warnMultiplier ?? 2;
  const critX = opts.criticalMultiplier ?? 4;
  const persist = opts.persist ?? true;
  const baselines = await loadBaselines(cwd);
  const alerts: AnomalyAlert[] = [];

  for (const sample of samples) {
    if (sample.status === "auth-failed" || sample.status === "no-api") continue;
    const prev = baselines[sample.policyKey];
    const baseline = prev?.avgDailyUsd ?? sample.current;
    const multiplier = baseline > 0 ? sample.current / baseline : 1;
    let severity: AnomalyAlert["severity"] | null = null;
    if (sample.capUsd && sample.current > sample.capUsd * 1.5) {
      severity = "critical";
    } else if (multiplier >= critX) {
      severity = "critical";
    } else if (multiplier >= warnX) {
      severity = "warn";
    }
    if (severity) {
      alerts.push({
        policyKey: sample.policyKey,
        provider: sample.provider,
        currentUsd: sample.current,
        baselineUsd: baseline,
        multiplier,
        severity,
        detail: sample.capUsd
          ? `current ${sample.current.toFixed(2)} USD vs baseline ${baseline.toFixed(2)} (${multiplier.toFixed(1)}×); cap ${sample.capUsd}`
          : `current ${sample.current.toFixed(2)} USD vs baseline ${baseline.toFixed(2)} (${multiplier.toFixed(1)}×)`,
      });
    }
    baselines[sample.policyKey] = updateBaseline(prev, sample);
  }

  if (persist) {
    await saveBaselines(cwd, baselines);
  }
  return alerts;
}
