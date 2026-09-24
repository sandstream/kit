import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  monkeyFinding,
  type MonkeyFinding,
  type MonkeyRunOptions,
} from "./monkey-test-contract.js";
import { redactSecrets, secretValuesFromEnv } from "./utils/redactSecrets.js";

export interface ExpectedReasonState {
  raw?: string;
  redacted?: string;
  valid: boolean;
}

export function parseEnvOutput(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const json = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = json ? JSON.parse(trimmed) : parseLiteralDotenv(text);
  } catch {
    throw new Error(
      "Temporary env output invalid; use literal JSON values or KEY=VALUE dotenv assignments",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Temporary env must be a JSON object or dotenv assignments");
  }
  assertLiteralValues(parsed);
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(
        ([key, value]) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
          (typeof value === "string" || typeof value === "number"),
      )
      .map(([key, value]) => [key, String(value)]),
  );
}

export function livePaymentEnvironmentFindings(
  env: NodeJS.ProcessEnv,
  source: string,
  file?: string,
): MonkeyFinding[] {
  const liveKey = Object.values(env).some((value) =>
    /^(?:sk|pk|rk)_live_/.test(value?.trim() ?? ""),
  );
  const liveMode = Object.entries(env).some(
    ([key, value]) =>
      /^(?:MONKEY_PAYMENT|STRIPE|PAYPAL|BRAINTREE|ADYEN|SQUARE)_(?:MODE|ENV|ENVIRONMENT)$/i.test(
        key,
      ) && /^(?:live|prod|production)$/i.test(value?.trim() ?? ""),
  );
  if (!liveKey && !liveMode) return [];
  return [
    monkeyFinding({
      severity: "critical",
      area: "money",
      title: "Live payment environment refused",
      file,
      repro: `Live payment configuration detected in ${source}`,
      fix: "Replace live payment configuration with provider sandbox/test credentials before running Monkey Test.",
    }),
  ];
}

function applicationEnvFiles(env: NodeJS.ProcessEnv): string[] {
  // Seed, dev servers and tests may select different standard modes in one run.
  const modes = new Set(["development", "test", "production", env.NODE_ENV]);
  const files = [".env", ".env.local"];
  for (const mode of modes) {
    if (mode && /^[A-Za-z0-9_-]{1,64}$/.test(mode)) {
      files.push(`.env.${mode}`, `.env.${mode}.local`);
    }
  }
  return files;
}

function assertLiteralValues(env: object): void {
  const referenceOrNul = new RegExp("\\0|\\$\\S|`");
  if (Object.values(env).some((value) => typeof value === "string" && referenceOrNul.test(value))) {
    throw new Error("Environment values must be literal and contain no NUL bytes");
  }
}

function parseLiteralDotenv(text: string): NodeJS.ProcessEnv {
  text = text.replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new Error("Invalid dotenv input");
  // Validate a shared literal subset, then let Node parse it. Other loaders differ
  // on colon assignments, escapes and interpolation; refuse those forms entirely.
  const entries = new RegExp(
    "[ \\t]*(?:#[^\\r\\n]*|" +
      "(?:export[ \\t]+)?[A-Za-z_][A-Za-z0-9_. \\t-]*=[ \\t]*" +
      "(?:'(?:[^'\\\\]|\\\\n)*'[ \\t]*|" +
      '"(?:[^"\\\\]|\\\\n)*"[ \\t]*|' +
      "[^ \\t#\\r\\n'\"`\\\\][^#\\r\\n'\"`\\\\]*)?" +
      "(?:#[^\\r\\n]*)?)?(?:\\r?\\n|$)",
    "gy",
  );
  let end = 0;
  const parsed: NodeJS.ProcessEnv = Object.create(null);
  // Parsing entries separately prevents Node from consuming the next assignment
  // as the value of an empty, whitespace-padded assignment.
  for (const match of text.matchAll(entries)) {
    end = match.index + match[0].length;
    Object.assign(parsed, parseEnv(match[0]));
  }
  if (end !== text.length) throw new Error("Unsupported dotenv syntax");
  assertLiteralValues(parsed);
  return parsed;
}

async function readApplicationEnv(path: string): Promise<NodeJS.ProcessEnv | undefined> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const maximum = 512 * 1024;
    const target = await handle.stat();
    if (!target.isFile() || target.size > maximum) throw new Error("Env file cannot be inspected");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) return parseLiteralDotenv(buffer.subarray(0, length).toString("utf8"));
      length += bytesRead;
    }
    throw new Error("Env file exceeds inspection limit");
  } finally {
    await handle.close();
  }
}

async function applicationEnvFindings(root: string, file: string): Promise<MonkeyFinding[]> {
  try {
    const env = await readApplicationEnv(join(root, file));
    return env ? livePaymentEnvironmentFindings(env, file, file) : [];
  } catch {
    return [
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Application env file could not be inspected",
        file,
        repro: `Inspect ${file} before running Monkey Test`,
        fix: "Use a readable regular dotenv file of at most 512 KiB with literal KEY=VALUE sandbox/test assignments. Resolve references and remove unsupported escapes or syntax before running.",
      }),
    ];
  }
}

export async function monkeyEnvironmentFindings(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<MonkeyFinding[]> {
  const findings = livePaymentEnvironmentFindings(env, "process environment");
  if (findings.length > 0) return findings;
  try {
    assertLiteralValues(env);
  } catch {
    return [
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Application environment could not be inspected",
        repro: "Inspect the effective process environment before running Monkey Test",
        fix: "Resolve environment references and use literal sandbox/test values with no NUL bytes.",
      }),
    ];
  }
  for (const file of applicationEnvFiles(env)) {
    findings.push(...(await applicationEnvFindings(root, file)));
  }
  return findings;
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
