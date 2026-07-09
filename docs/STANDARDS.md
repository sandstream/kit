# kit ↔ security standards — coverage & honest gaps

> **kit's stance.** This is an **evidence map, not a compliance attestation** — the same
> principle as `kit coverage`. It says which secure-software standards kit's shipped,
> deterministic controls align to, and — just as importantly — which ones kit does **not**
> yet take into account. Claiming coverage you don't have is exactly the false-green kit
> exists to prevent, so the gaps below are stated as plainly as the wins.

## 1. Standards kit takes into account today

| Standard | How kit engages it | Where |
|---|---|---|
| **OWASP Top 10 (2025)** | Per-category mapping of kit's shipped controls | `docs/OWASP_2025.md` |
| **OWASP ASVS 4.0.3 (L2)** | Deterministic **evidence map** (auto-verified / gap / manual / n-a) | `kit coverage [--json]` |
| **SLSA** | Build provenance / integrity framing | attestation + `docs/AUDIT_ATTESTATION.md` |
| **Sigstore / cosign** | Signature verification of artifacts | supply-chain paths |
| **OpenSSF Scorecard** | Repo-posture scoring in CI | `.github/workflows/scorecard.yml` |
| **CycloneDX + SPDX** | SBOM emit (incl. `--agent` toolchain) | `kit sbom` |
| **CVE / CWE / OSV / SARIF** | Vuln IDs, weakness taxonomy, findings interchange | `kit scan`, findings `rule` field |
| **EU CRA** | SBOM-mandate driver | `kit sbom` rationale |
| **GDPR** | PII redaction / memory handling | redaction + memory layer |

## 2. Standards kit does NOT yet take into account (ranked by fit)

Each of these is a genuine gap. Most are standards kit **already has controls for** but has
not **mapped** — the cheap, honest fix is to extend the `kit coverage` evidence-map machine,
not to invent new controls.

| # | Standard | Why it fits kit | Planned home |
|---|---|---|---|
| 1 | **NIST SSDF — SP 800-218** + **800-218A** (SSDF for generative AI) | The canonical "build software securely" framework; **218A is literally SSDF for GenAI** — the exact space kit occupies. Biggest gap. | `kit coverage` mapping + this doc |
| 2 | **OWASP Top 10 for LLM Applications (2025)** | kit maps the *web* Top 10 but not the *LLM* one, despite being an AI-agent tool. Prompt injection, tool poisoning, supply-chain are already shipped controls — just unmapped. | `kit coverage` mapping |
| 3 | **NIST AI RMF (AI 100-1) + Generative AI Profile (600-1)** | AI-specific risk framework; natural parallel to the OWASP mapping. | mapping doc |
| 4 | **MITRE ATLAS** | Adversarial-AI TTP matrix (ATT&CK for ML) — the vocabulary for the agent threats kit gates. | threat-model cross-ref |
| 5 | **OpenSSF S2C2F** (Secure Supply Chain **Consumption** Framework) | Near-perfect fit for install-triage / slopsquat / consumer-side verification — currently only referenced in passing, not mapped. | `kit coverage` mapping |
| 6 | **ISO/IEC 42001** (AI management system) | Certification track for AI governance (the ISO references in-repo are ISO-8601 dates, not 42001/27001). | evidence map (GRC) |

**Secondary / weaker fit:** OWASP **SAMM** & **BSIMM** (maturity models, not control checklists);
**EU AI Act** (regulatory, vs the CRA already covered); **CIS Benchmarks** (hadolint covers the
Docker slice); **SOC 2 / PCI-DSS / HIPAA** (compliance regimes — served indirectly by the
`kit coverage` evidence map rather than mapped directly).

## 3. Why "map", not "add"

The top three (SSDF/800-218A, OWASP LLM Top 10, S2C2F) are the highest-value because kit
*already ships* the controls they ask for — write-gate, injection quarantine, install-triage,
slopsquat scoring, deterministic gates. What's missing is the **crosswalk** from control →
standard clause, exactly what `kit coverage` already does for ASVS. So the plan is:

1. Extend `kit coverage` with pinned, curated mappings for **OWASP LLM Top 10** and **SSDF
   800-218A**, bucketed the same way (auto-verified / gap / manual / n-a).
2. Add **S2C2F** and **NIST AI RMF** as further evidence maps.
3. Before mapping, run a **verification pass** on the exact control IDs so kit never cites a
   clause number it hasn't confirmed (no false green).

Until then, this doc is the honest record: kit aligns to the §1 set and **does not yet
account for** the §2 set.
