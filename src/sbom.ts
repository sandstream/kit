/**
 * SBOM + SARIF emit (#61) — the emit side of the #48 ingest adapter.
 *
 * - SBOM from the dependency graph (`package-lock.json`) in **CycloneDX** + **SPDX**
 *   (interop + the EU CRA mandate: SBOM legally required Sept 2026 / Dec 2027).
 * - SARIF 2.1.0 from kit's own findings (so `kit scan --sarif` round-trips into the
 *   SARIF/OSV ecosystem the ingest adapter reads).
 *
 * Pure (data → document); fixture-tested. Reuses supply-chain's lockfile parser.
 */
import type { SecurityCheckResult } from "./check-security.js";
import type { LockPkg } from "./supply-chain.js";

export interface Component {
  name: string;
  version: string;
}

/** Lock packages → distinct {name, version} components (skips the root + versionless). */
export function lockComponents(lockPkgs: LockPkg[]): Component[] {
  const seen = new Set<string>();
  const out: Component[] = [];
  for (const p of lockPkgs) {
    if (!p.name || !p.version) continue;
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, version: p.version });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function purl(c: Component): string {
  return `pkg:npm/${c.name}@${c.version}`;
}

export function toCycloneDX(components: Component[]): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    components: components.map((c) => ({ type: "library", name: c.name, version: c.version, purl: purl(c) })),
  };
}

export function toSpdx(components: Component[], name = "kit-sbom"): unknown {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    packages: components.map((c, i) => ({
      name: c.name,
      SPDXID: `SPDXRef-Package-${i}`,
      versionInfo: c.version,
      downloadLocation: "NOASSERTION",
      externalRefs: [
        { referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: purl(c) },
      ],
    })),
  };
}

function sarifLevel(sev: SecurityCheckResult["severity"]): "error" | "warning" | "note" {
  return sev === "critical" || sev === "high" ? "error" : sev === "medium" ? "warning" : "note";
}

/** kit findings → SARIF 2.1.0 (one run, kit as the tool, rules carry the citation). */
export function toSarif(findings: SecurityCheckResult[]): unknown {
  const rules = [...new Map(findings.map((f) => [f.name, f])).values()].map((f) => ({
    id: f.name,
    name: f.name,
    properties: {
      ...(f.severity ? { "security-severity": { critical: "9.5", high: "8.0", medium: "5.0", low: "2.0" }[f.severity] } : {}),
      ...(f.rule ? { tags: [f.rule.id], helpUri: f.rule.ref } : {}),
    },
  }));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: { driver: { name: "kit", informationUri: "https://github.com/sandstream/kit", rules } },
        results: findings.map((f) => ({
          ruleId: f.name,
          level: sarifLevel(f.severity),
          message: { text: f.detail ?? f.name },
        })),
      },
    ],
  };
}
