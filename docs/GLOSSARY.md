# kit glossary — acronyms & terms

A plain-language reference for the acronyms that show up across kit's code, docs, and
output. Grouped by area; kit-specific meaning noted where it matters.

## Supply chain & SBOM

| Term | Expansion | What it means in kit |
|---|---|---|
| **SBOM** | Software Bill of Materials | Machine-readable inventory of every component + version in a build. `kit sbom` emits it; `kit sbom --agent` also lists the agent toolchain (skills, MCP servers, plugins). |
| **MBOM** | Model Bill of Materials | The SBOM idea applied to ML models (weights, datasets, lineage). Named as an unrealized opportunity in the LLM-supply-chain agenda behind G5. |
| **CycloneDX** | *(not an acronym)* | An OWASP SBOM format. One of the two kit emits. |
| **SPDX** | Software Package Data Exchange | A Linux Foundation SBOM/license format. kit's other SBOM output. |
| **purl** | Package URL | A standard identifier like `pkg:npm/lodash@4.17.21`; kit uses `pkg:generic/<kind>/…` for agent components. |
| **CRA** | (EU) Cyber Resilience Act | EU regulation that makes an SBOM legally required (2026/2027) — a driver for `kit sbom`. |
| **SLSA** | Supply-chain Levels for Software Artifacts | A provenance/integrity framework kit references for build attestation. |
| **CVE** | Common Vulnerabilities and Exposures | The public ID scheme for known vulns (e.g. `CVE-2025-49596`). |
| **CWE** | Common Weakness Enumeration | Weakness-type catalog kit findings cite in their `rule` field. |
| **OSV** | Open Source Vulnerabilities | Google's vuln database/format kit's ingest adapter reads. |
| **SARIF** | Static Analysis Results Interchange Format | The JSON format `kit scan --sarif` emits so findings round-trip into other tools. |
| **slopsquat(ting)** | *(coinage: "slop" + typosquat)* | Registering package names an LLM is likely to hallucinate. `kit slopsquat` scores that risk (G4). |

## AI-agent security

| Term | Expansion | What it means in kit |
|---|---|---|
| **LLM** | Large Language Model | The model an agent runs on. kit's verdicts are deliberately **zero-LLM** (see `docs/ZERO_LLM_CONTRACT.md`). |
| **MCP** | Model Context Protocol | The protocol agents use to call external tools/servers. `kit triage mcp` checks tool metadata (G3). |
| **PAL** | Pending-Action Layer | kit's structured, actionable to-do layer on top of raw conversation memory. |
| **tool poisoning** | *(term)* | Malicious instructions hidden in an MCP tool's description/params — the top MCP client-side vuln G3 scans for. |
| **rug pull** | *(term)* | A server silently changing a tool definition after you trusted it; G3 pins a hash to detect it. |
| **prompt injection** | *(term)* | Untrusted text that hijacks a model's instructions; kit quarantines high-confidence patterns at capture. |
| **DIFC** | Decentralized Information Flow Control | A capability/data-flow model for constraining what agents can do (referenced re: CaMeL). |
| **CaMeL** | Capabilities for Machine Learning | A DeepMind deterministic prompt-injection defense kit's design aligns with. |
| **CSI** | Cybersecurity Information Sheet | The NSA MCP-security guidance kit's approach is grounded in. |

## Cryptography & identity

| Term | Expansion | What it means in kit |
|---|---|---|
| **HMAC** | Hash-based Message Authentication Code | Keyed integrity tag; kit's audit-log anchor uses one. |
| **Ed25519** | *(the signature scheme)* | The elliptic-curve algorithm kit signs identities, policy, and shared memory with. |
| **SHA-256** | Secure Hash Algorithm, 256-bit | Content hashing — e.g. verified-forget tombstones, MCP toolset pins. |
| **AES-256-GCM** | Advanced Encryption Standard / Galois-Counter Mode | Authenticated encryption used for encrypted sync blobs. |
| **JWT** | JSON Web Token | A signed token format kit's secret detector recognizes (and skips known public demo keys). |
| **TOTP** | Time-based One-Time Password | 2FA codes; kit treats them as secrets. |
| **TPM / HSM** | Trusted Platform Module / Hardware Security Module | Hardware key stores; the "regulated tier" for non-exportable keys (kit 5.0 north star). |
| **TOFU** | Trust On First Use | Pin-on-first-sight trust model (same shape as the MCP drift pin). |
| **TSA** | Time-Stamping Authority | Trusted timestamp source for attestations. |
| **GPG** | GNU Privacy Guard | OpenPGP signing kit can verify. |

## Standards, compliance & governance

| Term | Expansion | What it means in kit |
|---|---|---|
| **OWASP** | Open Worldwide Application Security Project | Security standards body; kit maps to its 2025 lists. |
| **ASVS** | Application Security Verification Standard | OWASP control set; `kit coverage` emits an ASVS L2 evidence map. |
| **GRC** | Governance, Risk & Compliance | The tooling category `kit coverage --json` feeds. |
| **RBAC** | Role-Based Access Control | Permission model for the (experimental) team layer. |
| **IAM** | Identity and Access Management | Access-control surface kit reasons about. |
| **PII** | Personally Identifiable Information | Personal data (e.g. Luhn-validated personnummer) kit redacts/flags. |
| **GDPR** | General Data Protection Regulation | EU privacy law relevant to memory/PII handling. |
| **NIST** | National Institute of Standards and Technology | US standards body kit references. |
| **DAST / SAST** | Dynamic / Static Application Security Testing | CI stages (SAST runs; DAST is skipped — kit has no HTTP surface). |

## Storage, runtime & general

| Term | Expansion | What it means in kit |
|---|---|---|
| **CLI** | Command-Line Interface | kit itself. |
| **SDK** | Software Development Kit | e.g. the frozen `adapter-sdk`; also the banned LLM SDKs (zero-LLM boundary). |
| **API** | Application Programming Interface | kit's public surface (frozen + snapshot-tested). |
| **CI / CD** | Continuous Integration / Delivery | The pipelines kit's gates run in. |
| **FTS5** | Full-Text Search v5 | SQLite's search extension backing memory recall. |
| **WAL** | Write-Ahead Logging | SQLite journal mode; kit secures its `-wal`/`-shm` sidecars too. |
| **UID** | User Identifier | The "same-UID" trust boundary (a local user who can read a 0600 file). |
| **TTL** | Time To Live | Expiry window (e.g. triage-log freshness). |
| **POSIX** | Portable Operating System Interface | The shell environment kit assumes (macOS/Linux/WSL2). |
| **CC0** | Creative Commons Zero | The public-domain data license on SPDX output. |

## kit-internal

| Term | Meaning |
|---|---|
| **R1–R13** | kit's internal **self-audit rule IDs** — the bug-classes `kit self-audit` gates against. Notables: **R7** = quarantine high-confidence prompt-injection at memory capture (and the R7-hardened resilient store scan); **R13** = catch-false-green (a check that can't run must fail, not silently pass). |
| **gate** | A deterministic, fail-closed check on the action path (PreToolUse `gate-bash`/`gate-env`) or at review time (`kit check`). |
| **warn → enforce** | The secure-by-default ramp: a new gate warns first, then fails once `--enforce` / an env flag is set. |
| **no false green** | kit's core ethos — green must be *earned*; an un-runnable check fails. |
| **G1–G6** | The six buildout gaps from the deep-research gap analysis (write-gate, secrets, MCP triage, slopsquat, SBOM, zero-LLM contract). |

*Missing one? Add a row and send a PR — this file is meant to grow.*
