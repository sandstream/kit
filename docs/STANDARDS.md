# kit ↔ security standards — coverage & honest gaps

> **kit's stance.** This is an **evidence map, not a compliance attestation** — the same
> principle as `kit coverage`. It says which secure-software standards kit's shipped,
> deterministic controls align to, and — just as importantly — which ones kit does **not**
> yet take into account. Claiming coverage you don't have is exactly the false-green kit
> exists to prevent, so the gaps below are stated as plainly as the wins.

## 1. Standards kit takes into account today

| Standard                                        | How kit engages it                                                  | Where                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| **OWASP Top 10 (2025)**                         | Per-category mapping of kit's shipped controls                      | `docs/OWASP_2025.md`                      |
| **OWASP ASVS 4.0.3 (L2)**                       | Deterministic **evidence map** (auto-verified / gap / manual / n-a) | `kit coverage [--json]`                   |
| **SLSA**                                        | Build provenance / integrity framing                                | attestation + `docs/AUDIT_ATTESTATION.md` |
| **Sigstore / cosign**                           | Signature verification of artifacts                                 | supply-chain paths                        |
| **OpenSSF Scorecard**                           | Repo-posture scoring in CI                                          | `.github/workflows/scorecard.yml`         |
| **CycloneDX + SPDX**                            | SBOM emit (incl. `--agent` toolchain)                               | `kit sbom`                                |
| **CVE / CWE / OSV / SARIF**                     | Vuln IDs, weakness taxonomy, findings interchange                   | `kit scan`, findings `rule` field         |
| **OWASP Top 10 for LLM Applications (2025)**    | Evidence map of LLM01–LLM10 → kit controls                          | `kit coverage --standard=llm-top10`       |
| **NIST SSDF (SP 800-218 / 218A GenAI profile)** | Evidence map of the practices kit speaks to (PO/PS/PW/RV)           | `kit coverage --standard=ssdf`            |
| **EU CRA**                                      | SBOM-mandate driver                                                 | `kit sbom` rationale                      |
| **GDPR**                                        | PII redaction / memory handling                                     | redaction + memory layer                  |

## 2. Standards kit does NOT yet take into account (ranked by fit)

Each of these is a genuine gap. Most are standards kit **already has controls for** but has
not **mapped** — the cheap, honest fix is to extend the `kit coverage` evidence-map machine,
not to invent new controls.

| #        | Standard                                                          | Why it fits kit                                                                                                                  | Planned home           |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| ~~1~~ ✅ | **NIST SSDF — SP 800-218 / 218A**                                 | **Now mapped** at the practice level 218A profiles — `kit coverage --standard=ssdf` (see §1).                                    | done                   |
| ~~2~~ ✅ | **OWASP Top 10 for LLM Applications (2025)**                      | **Now mapped** — `kit coverage --standard=llm-top10` (see §1).                                                                   | done                   |
| 3        | **NIST AI RMF (AI 100-1) + Generative AI Profile (600-1)**        | AI-specific risk framework; natural parallel to the OWASP mapping.                                                               | `kit coverage` mapping |
| 4        | **MITRE ATLAS**                                                   | Adversarial-AI TTP matrix (ATT&CK for ML) — the vocabulary for the agent threats kit gates.                                      | threat-model cross-ref |
| 5        | **OpenSSF S2C2F** (Secure Supply Chain **Consumption** Framework) | Near-perfect fit for install-triage / slopsquat / consumer-side verification — currently only referenced in passing, not mapped. | `kit coverage` mapping |
| 6        | **ISO/IEC 42001** (AI management system)                          | Certification track for AI governance (the ISO references in-repo are ISO-8601 dates, not 42001/27001).                          | evidence map (GRC)     |

**Secondary / weaker fit:** OWASP **SAMM** & **BSIMM** (maturity models, not control checklists);
**EU AI Act** (regulatory, vs the CRA already covered); **CIS Benchmarks** (hadolint covers the
Docker slice); **SOC 2 / PCI-DSS / HIPAA** (compliance regimes — served indirectly by the
`kit coverage` evidence map rather than mapped directly).

## 3. Why "map", not "add"

The top ones are highest-value because kit _already ships_ the controls they ask for —
write-gate, injection quarantine, install-triage, slopsquat scoring, deterministic gates.
What was missing was the **crosswalk** from control → standard clause, exactly what
`kit coverage` already does for ASVS. Status:

1. ✅ **Done:** `kit coverage --standard=llm-top10` and `--standard=ssdf` — pinned, curated
   maps bucketed the same way (auto / gap / manual / n-a), built on a generic evidence-map
   engine (`src/coverage/standard.ts`). Control IDs were verified (a source-run confirmed the
   LLM01–LLM10 titles and the PO/PS/PW/RV practices) before mapping — no invented clause numbers.
   Caveat carried into the disclaimer: IDs were confirmed via search index, not first-party
   fetch (egress-blocked), and kit does not enumerate 218A's specific AI task augmentations.
2. **Next:** add **S2C2F** and **NIST AI RMF** as further evidence maps (same engine).
3. Every mapping stays behind the "no false green" rule — a clause kit can't confirm is not cited.

This doc is the honest record: kit aligns to the §1 set (now including OWASP LLM Top 10 + NIST
SSDF) and **does not yet account for** the remaining §2 set.
