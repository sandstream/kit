/**
 * Coverage-standards registry — the single source of truth for which pinned
 * standards `kit coverage` can map against. Adding a new standard is one entry
 * here (plus its descriptor file); the CLI, `--list-standards`, `--standard=all`,
 * and the `[coverage].standards` on/off toggle all derive from this list.
 *
 * ASVS is the original path (its own `buildCoverageReport`); every other standard
 * routes through the generic `buildStandardReport` engine via a `StandardDescriptor`.
 */
import type { StandardDescriptor } from "./standard.js";
import { ASVS_VERSION } from "./asvs-l2.js";
import { OWASP_LLM_TOP10 } from "./owasp-llm-top10.js";
import { SSDF_218A } from "./ssdf-218a.js";
import { OWASP_AGENTIC_TOP10 } from "./owasp-agentic-top10.js";
import { OWASP_MCP_TOP10 } from "./owasp-mcp-top10.js";
import { AIUC_1 } from "./aiuc-1.js";
import { GCP_WAF_SECURITY } from "./gcp-waf-security.js";
import { NIST_800_53 } from "./nist-800-53.js";

export interface CoverageStandard {
  /** CLI selector, e.g. "asvs" | "llm-top10" | "agentic-top10". */
  key: string;
  /** Human label for --list-standards. */
  label: string;
  /** Pinned version string. */
  version: string;
  /** 'asvs' → legacy buildCoverageReport path; 'descriptor' → generic engine. */
  kind: "asvs" | "descriptor";
  /** Present iff kind === 'descriptor'. */
  descriptor?: StandardDescriptor;
}

const fromDescriptor = (d: StandardDescriptor): CoverageStandard => ({
  key: d.key,
  label: d.label,
  version: d.version,
  kind: "descriptor",
  descriptor: d,
});

/** All registered standards, in display order. ASVS stays first (the default). */
export const COVERAGE_STANDARDS: readonly CoverageStandard[] = [
  { key: "asvs", label: "OWASP ASVS (L2 subset)", version: ASVS_VERSION, kind: "asvs" },
  fromDescriptor(OWASP_LLM_TOP10),
  fromDescriptor(SSDF_218A),
  fromDescriptor(OWASP_AGENTIC_TOP10),
  fromDescriptor(OWASP_MCP_TOP10),
  fromDescriptor(AIUC_1),
  fromDescriptor(GCP_WAF_SECURITY),
  fromDescriptor(NIST_800_53),
];

export const COVERAGE_STANDARD_KEYS: readonly string[] = COVERAGE_STANDARDS.map((s) => s.key);

export function getCoverageStandard(key: string): CoverageStandard | undefined {
  return COVERAGE_STANDARDS.find((s) => s.key === key);
}

/**
 * Resolve which standards are enabled given the optional `[coverage].standards`
 * allow-list from .kit.toml. Absent or empty ⇒ every registered standard is
 * enabled (backwards-compatible). Unknown keys in the config are ignored here
 * (the caller may warn). Order follows the registry, not the config.
 */
export function enabledCoverageStandards(configStandards?: readonly string[]): CoverageStandard[] {
  if (!configStandards || configStandards.length === 0) return [...COVERAGE_STANDARDS];
  const allow = new Set(configStandards);
  return COVERAGE_STANDARDS.filter((s) => allow.has(s.key));
}

/** Is `key` enabled under the given config toggle? Empty/absent config ⇒ all on. */
export function isCoverageStandardEnabled(
  key: string,
  configStandards?: readonly string[],
): boolean {
  if (!configStandards || configStandards.length === 0) return true;
  return configStandards.includes(key);
}
