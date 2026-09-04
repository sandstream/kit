import type { MonkeyRunOptions } from "./monkey-test-contract.js";
import { redactSecrets, secretValuesFromEnv } from "./utils/redactSecrets.js";

export interface ExpectedReasonState {
  raw?: string;
  redacted?: string;
  valid: boolean;
}

export function parseEnvOutput(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" || typeof value === "number")
        .map(([key, value]) => [key, String(value)]),
    );
  } catch {
    const out: Record<string, string> = {};
    for (const line of trimmed.split("\n")) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const eq = clean.indexOf("=");
      if (eq <= 0) continue;
      const key = clean.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      out[key] = clean.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
    return out;
  }
}

export function expectedReasonState(options: MonkeyRunOptions): ExpectedReasonState {
  const raw = options.expectedReason ?? process.env.MONKEY_EXPECTED_REASON;
  return {
    raw,
    redacted: raw ? redactSecrets(raw, secretValuesFromEnv(process.env)) : undefined,
    valid: (raw?.trim().length ?? 0) >= 12,
  };
}

export function runnerEnvironment(options: MonkeyRunOptions, runId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "test",
    STRIPE_ENV: process.env.STRIPE_ENV ?? "test",
    MONKEY_RUN_ID: runId,
    MONKEY_LINK_DEPTH: String(options.linkDepth ?? process.env.MONKEY_LINK_DEPTH ?? 2),
  };
}
