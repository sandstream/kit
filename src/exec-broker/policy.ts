// Pillar 3 — exec-broker: policy shape + fail-closed loader.
//
// The BrokerPolicy declares what an operation is ALLOWED to touch: an egress
// hostname allowlist, a filesystem write root, and the environment keys it may
// see. It is read from a standalone JSON file resolved via the module's mandated
// KIT_<X> knob (KIT_EXEC_BROKER_POLICY), else a repo-local default
// (.kit-exec-broker.json under cwd).
//
// FAIL-CLOSED / NO FALSE-GREEN: an absent, unreadable, malformed, or wrong-typed
// policy loads as `null` — never a permissive default. brokerExec treats null as
// default-deny, so a missing policy blocks everything rather than silently
// allowing it. Validation is strict: any deviation → null.
//
// Zero LLM, zero network. Synchronous local file read only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BrokerPolicy {
  egress: { allow: string[] };
  /**
   * Filesystem write-scope. `root` is the primary allowed root (required, back-compatible with
   * the original single-root policy + `.kit-exec-broker.json`). `roots` optionally adds more
   * allowed roots — the effective allowed set is `[root, ...roots]`. This lets a richer source
   * (the signed profile's `[scope].fs` path LIST) map faithfully without breaking the JSON shape.
   */
  fs: { root: string; roots?: string[] };
  env: { declared: string[] };
}

/** The effective list of allowed write-roots for a policy: `[root, ...roots]`, de-duplicated. */
export function policyFsRoots(policy: BrokerPolicy): string[] {
  return [...new Set([policy.fs.root, ...(policy.fs.roots ?? [])])];
}

/** The env override knob for this module (mirrors the amazonq/kiro parsers). */
export const BROKER_POLICY_ENV = "KIT_EXEC_BROKER_POLICY";

/** Default policy filename resolved against cwd when no override is set. */
export const DEFAULT_BROKER_POLICY_FILE = ".kit-exec-broker.json";

/**
 * Resolve the broker policy file path. Precedence: explicit `override` arg →
 * KIT_EXEC_BROKER_POLICY env → repo-local .kit-exec-broker.json under cwd.
 */
export function brokerPolicyPath(override?: string): string {
  const chosen = override ?? process.env[BROKER_POLICY_ENV];
  if (chosen && chosen.length > 0) return resolve(chosen);
  return resolve(process.cwd(), DEFAULT_BROKER_POLICY_FILE);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Strict validation of a parsed JSON value into a BrokerPolicy, or null if it
 * deviates in any way (fail-closed, no false-green).
 */
function validateBrokerPolicy(parsed: unknown): BrokerPolicy | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  const egress = p.egress as Record<string, unknown> | undefined;
  if (typeof egress !== "object" || egress === null || !isStringArray(egress.allow)) return null;

  const fs = p.fs as Record<string, unknown> | undefined;
  if (typeof fs !== "object" || fs === null) return null;
  if (typeof fs.root !== "string" || fs.root.length === 0) return null;
  // Optional `roots`: when present it must be a string[] (fail-closed on any other shape).
  if (fs.roots !== undefined && !isStringArray(fs.roots)) return null;

  const env = p.env as Record<string, unknown> | undefined;
  if (typeof env !== "object" || env === null || !isStringArray(env.declared)) return null;

  return {
    egress: { allow: [...egress.allow] },
    fs: fs.roots ? { root: fs.root, roots: [...fs.roots] } : { root: fs.root },
    env: { declared: [...env.declared] },
  };
}

/**
 * Load + parse + validate the broker policy. Returns null on absent, unreadable,
 * malformed, or wrong-typed input so brokerExec default-denies. Never throws.
 */
export function loadBrokerPolicy(override?: string): BrokerPolicy | null {
  const path = brokerPolicyPath(override);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // absent / unreadable → fail-closed
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON → fail-closed
  }
  return validateBrokerPolicy(parsed);
}
