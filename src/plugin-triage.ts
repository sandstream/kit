/**
 * kit — plugin triage (Pillar 4 BYO-gap).
 *
 * `kit triage plugin` closes the documented BYO-triage gap: plugins (npm packages listed in
 * `package.json` `kitPlugins`) are executable supply-chain components — `loadPluginAdapters`
 * imports and RUNS them — but nothing triaged them before trust.
 *
 * Two deterministic, zero-LLM angles, mirroring `kit triage mcp` WITHOUT importing untrusted
 * plugin code (import is exactly what triage must precede):
 *   1. supply-chain safety — delegate to the existing npm registry triage (install-scripts,
 *      slopsquat, dep-confusion) per plugin (done in the command);
 *   2. manifest-poisoning — run kit's R7 injection detector over the plugin's PUBLISHED
 *      metadata (package.json description / keywords), so a plugin whose manifest smuggles
 *      agent instructions is caught statically (this module).
 *
 * Version drift / rug-pull is deliberately NOT re-implemented here — `kit profile check` already
 * audits declared-vs-installed plugin versions. This module is the pure, unit-testable piece;
 * only the command reads package.json off disk.
 */
import { findInjection } from "./memory/injection.js";
import type { InjectionConfidence } from "./memory/injection.js";

export interface PluginManifestFinding {
  /** Which manifest field carried the pattern: "description" or "keywords". */
  field: string;
  label: string;
  confidence: InjectionConfidence;
}

/**
 * Statically scan a plugin's package.json for injection/poisoning patterns in its published
 * metadata. Pure + deterministic — never imports or executes the plugin. Returns [] for a
 * missing/garbage manifest.
 */
export function scanPluginManifest(pkg: unknown): PluginManifestFinding[] {
  const out: PluginManifestFinding[] = [];
  if (!pkg || typeof pkg !== "object") return out;
  const o = pkg as Record<string, unknown>;
  if (typeof o.description === "string") {
    for (const f of findInjection(o.description)) {
      out.push({ field: "description", label: f.label, confidence: f.confidence });
    }
  }
  if (Array.isArray(o.keywords)) {
    for (const kw of o.keywords) {
      if (typeof kw !== "string") continue;
      for (const f of findInjection(kw)) {
        out.push({ field: "keywords", label: f.label, confidence: f.confidence });
      }
    }
  }
  return out;
}

/** True when a manifest scan surfaced a high-confidence poisoning pattern (a triage failure). */
export function manifestHasHighRisk(findings: PluginManifestFinding[]): boolean {
  return findings.some((f) => f.confidence === "high");
}
