# Would kit have found the AISLE curl/Linux findings?

Date: 2026-08-26

## Short answer

No, not by itself. kit's current core would not have independently discovered
the curl/Linux source-level zero-day findings being claimed for AISLE. kit is a
deterministic local gate: secrets, known vulnerable dependencies, supply-chain
policy, scanner orchestration, SAST when configured, and external finding
ingest. AISLE's cited wins are mostly semantic source-code findings: memory
lifetime, state reuse, protocol/API invariants, authorization asymmetry, and
race conditions. Those require a vulnerability-research engine, model-assisted
analysis, specialized rules, fuzzing/sanitizers, or human review above kit.

kit could still be the right control plane for such a tool: run the external AI
scanner, ingest its findings, fail the local/CI gate on high severity, and keep
receipts. That matches kit's documented seam: model-shaped work lives above kit;
kit owns the deterministic floor.

## Verified facts

- Daniel Stenberg wrote on 2026-05-11 that, before the Mythos scan, curl had
  already been scanned with AI-powered tools including AISLE, Zeropath, and
  OpenAI Codex Security; those tools together had driven roughly 200-300 curl
  bugfixes in the prior 8-10 months and "a dozen or more" CVEs. Source:
  [Mythos finds a curl vulnerability](https://daniel.haxx.se/blog/2026/05/11/mythos-finds-a-curl-vulnerability/).
- In the same post, Stenberg says Mythos reported five "confirmed" security
  vulnerabilities, but curl's security team accepted one as a confirmed
  vulnerability, treated three as false positives, and treated one as a bug but
  not a vulnerability. He also says AI tools find known kinds of mistakes, not a
  novel vulnerability class. Source:
  [Mythos finds a curl vulnerability](https://daniel.haxx.se/blog/2026/05/11/mythos-finds-a-curl-vulnerability/).
- curl 8.21.0, released 2026-06-24, published 18 security fixes. Source:
  [curl 8.21.0](https://daniel.haxx.se/blog/2026/06/24/curl-8-21-0/).
- curl's own advisories credit Joshua Rogers (Aisle Research) for these
  2026-06-24 advisories:
  [CVE-2026-8925](https://curl.se/docs/CVE-2026-8925.html) SASL double-free,
  [CVE-2026-8926](https://curl.se/docs/CVE-2026-8926.html) netrc credential
  leak, [CVE-2026-8932](https://curl.se/docs/CVE-2026-8932.html) incomplete
  mTLS connection-reuse matching,
  [CVE-2026-9080](https://curl.se/docs/CVE-2026-9080.html) use-after-free
  after pause in socket callback,
  [CVE-2026-9547](https://curl.se/docs/CVE-2026-9547.html) SSH host validation,
  and [CVE-2026-10536](https://curl.se/docs/CVE-2026-10536.html) HTTP/2
  stream-dependency tree use-after-free.
- AISLE's own public claim is broader: it says AISLE found 29 valid curl
  findings and 5 CVEs in fall 2025, then 6 of the 18 CVEs in the curl 8.21.0
  release. This is a first-party product claim, partly corroborated by curl's
  advisory credits for the named CVEs. Source:
  [AISLE Discovers 6 New CVEs in curl](https://aisle.com/blog/aisle-discovers-6-new-cves-in-curl-including-the-oldest-issue-ever-reported).
- Public Linux-kernel artifacts show AISLE-assisted patches by Joshua Rogers
  signed by Greg Kroah-Hartman, for example a VT tty reference fix and a VCC
  port-lock fix. One of those is tracked as CVE-2026-74675. Sources:
  [LKML archive: vt tty reference patch](https://lkml.iu.edu/hypermail/linux/kernel/2607.3/15176.html),
  [LKML archive: vcc port lock patch](https://lkml.iu.edu/hypermail/linux/kernel/2607.3/15230.html),
  [NVD CVE-2026-74675](https://nvd.nist.gov/vuln/detail/CVE-2026-74675).

## Unverified or product/social claims

- I did not find a primary copy of the exact quoted social reply from Greg KH:
  "I'm seeing the same for Linux as well. No idea what Aisle is doing ?". Treat
  the quote as unverified unless a first-party social.kernel.org, LinkedIn, or
  mailing-list URL is provided.
- AISLE's statements about relative performance versus Mythos, 95% noise
  reduction, 10x cost efficiency, and "outperforming" frontier models are
  product claims. Some public curl and Linux artifacts support that AISLE found
  real issues, but they do not independently prove AISLE's comparative product
  metrics. Sources: [AISLE home](https://aisle.com/) and
  [AI Code Analysis Beats SAST](https://aisle.com/blog/attackers-are-using-ai-to-find-vulnerabilities-in-your-code-your-sast-was-never-even-looking-for-them).

## What kit would catch

kit would catch these adjacent classes today:

- Known dependency CVEs after disclosure, if the affected package appears in a
  supported lockfile/container/image and the scanner database includes it.
  Source: `checkNpmAudit`, `checkPipAudit`, `checkOsvScanner`, and Trivy paths
  in [src/check-security.ts](../../src/check-security.ts).
- Secret leaks and secret-shaped strings in code, git history, build artifacts,
  transcripts, and staged files. Source:
  [src/check-security.ts](../../src/check-security.ts) and
  [src/commands/security.ts](../../src/commands/security.ts).
- Supply-chain compromise catalog matches via bumblebee. Source:
  [src/check-security.ts](../../src/check-security.ts).
- Semgrep SAST findings only when `KIT_SEMGREP_CONFIG` is set and Semgrep can
  run. Source: [src/check-security.ts](../../src/check-security.ts) and
  [src/scanners.ts](../../src/scanners.ts).
- Cross-repo security posture gaps such as missing gitignore coverage, tracked
  secret files, branch protection, npm audit high findings, bumblebee findings,
  and workflow drift. Source:
  [src/security-prescan.ts](../../src/security-prescan.ts).

## What kit would not catch

kit would not currently discover these AISLE-style issues from source alone:

- curl SASL double-free before it was published as a CVE.
- curl connection reuse or credential-state bugs where the defect is "option A
  changed but connection/cache matching did not account for it."
- libcurl callback lifecycle use-after-free unless a deterministic tool reports
  it.
- Linux tty/vt race and authorization asymmetry unless a scanner, rule, or human
  review emits a finding.
- "29 additional findings" in a mature C codebase from semantic variant hunting.

Reason: kit core is zero-LLM by accepted ADR, and its security gates are
reproducible scanner orchestration rather than autonomous vulnerability
research. Sources: [ADR-0001](../adr/0001-zero-llm-core.md) and
[ADR-0004](../adr/0004-agent-skills-operate-above-kit.md).

## Operational recommendation

Do not position kit as a replacement for AISLE/Mythos/Codex Security/CodeQL or
human vulnerability research. Position kit as the shared local control plane:

1. AI/security scanner runs above kit.
2. Scanner writes SARIF or `.kit-scan-results.jsonl`.
3. kit ingests the current findings and makes the local/CI gate fail on high or
   critical severity.
4. `kit check --strict`, policy, receipts, and memory make the result portable
   across Claude, Codex, local dev, and CI.

The existing external finding contract already supports this without pulling an
LLM into kit core. Source: [docs/EXTERNAL_FINDINGS.md](../EXTERNAL_FINDINGS.md).

## Bottom line

If the question is "would kit itself have produced `AISLE: 29` on curl?", the
answer is no.

If the question is "can kit make sure AISLE-like findings are not lost and can
block work once found?", the answer is yes, using external finding ingest and
required scanner policy.
