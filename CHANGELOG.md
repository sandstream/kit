# Changelog

All notable changes to kit are documented in this file. This project adheres to [Semantic Versioning](https://semver.org/).

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.2.0] - 2026-06-16

### Added
- **Multi-harness memory** — `kit memory index` now pulls transcripts from every supported coding agent on the machine, each tagged with a `harness` so recall spans them: **Claude Code** (`~/.claude`), **Codex** (`~/.codex/sessions`), **Gemini CLI** (`~/.gemini/tmp`), and **Continue.dev** (`~/.continue/sessions`). New `indexAllHarnesses()` registry with per-harness counts in the index report. Each parser is built against the agent's own serialization format (verified from its source), never guessed; absent agents are skipped silently. Adding a harness is a single parser. GitHub Copilot CLI is deliberately excluded until its `events.jsonl` has a documented schema/stability contract (see [copilot-cli#3551](https://github.com/github/copilot-cli/issues/3551)).
- **`kit status [--json]`** — a deterministic cross-subsystem adoption checklist: which subsystems are set up (config, secrets vault, tools, gitignore hygiene, dependency policy, agent-config, memory, hooks) plus a rule-based next step for each gap. No inference — every signal is read from real local state.
- **SessionStart recovery hook** — a third fail-open memory hook that re-injects the current project's most-recent messages + open action items after a resume/compaction, so a session regains continuity instead of starting blank. Wired by `kit memory install` alongside `UserPromptSubmit` + `SessionEnd`.
- **`kit memory merge <other.db>`** — consolidate another machine's memory store into this one (idempotent, dedup by message uuid) — e.g. folding a laptop's history into a workstation's.
- **Google web-search provider** — `kit check`'s web-search probe now runs a real Custom Search JSON API health check (config `apiKey` + `cx`), replacing the previous not-implemented stub.

### Changed
- **Incremental indexing** — `kit memory index` skips transcripts unchanged since the last run via a new `file_index` table (mtime + size), with the per-message uuid dedup as a backstop. Re-indexing a large history is now near-instant.

## [1.1.0] - 2026-06-16

### Added
- **`kit memory`** — a local-first, deterministic second brain (SQLite + FTS5, zero model calls, two fail-open hooks). Index `~/.claude` transcripts, project-scoped full-text `search`, `UserPromptSubmit` reminder + `SessionEnd` sync, encrypted `backup`/`restore` for disaster recovery, `scan` for secrets stored in the DB, a pending-action ledger (`pal`, auto-closes on verify), named-copilot bookmarks (`save`/`threads`/`resume`), and a curated, area-organized, secret-scanned shared team tier (`share`/`areas`/`area`). See [`docs/MEMORY.md`](docs/MEMORY.md). Schema + two-hook design credited to [cloudctx](https://github.com/chadptk1238/cloudctx) (MIT).

## [1.0.1] - 2026-06-14

### Changed
- Documentation and packaging cleanup ahead of the public release.

> Public versioning for `sandstream-kit` starts at **1.0.0** — the first published release. Entries below this point document the unpublished `sandstream-kit` development lineage and are kept for internal traceability.

## [1.1.0] - 2026-05-30

### Added
- **Full-app security workflow** (`.github/workflows/security.yml`) with 9 gating stages: deps (npm audit + Snyk), supply-chain (bumblebee), SAST (ESLint + Semgrep + SonarCloud), DAST (ZAP — scoped out for CLI), container (Trivy CRITICAL+HIGH SARIF), infrastructure (Checkov + tfsec), secrets (gitleaks), GDPR + headers, kit self-check, plus aggregated gate
- **Agent-hook templates** (`examples/agent-hooks/`) for Claude Code (PostToolUse), Codex (AGENTS.md + MCP), Cursor (.cursorrules + .cursor/mcp.json), Cline (.clinerules + MCP autoApprove). Cross-provider git pre-commit fallback documented in `examples/agent-hooks/README.md`
- Supply-chain exposure scanning via [bumblebee](https://github.com/perplexityai/bumblebee)
  - New `supply-chain` security check in `kit check` / `kit ci` that flags installed packages matching curated known-compromise catalogs (Shai-Hulud, typosquats, credential stealers, malicious editor/browser extensions, MCP servers)
  - Pinned release binary auto-downloaded and SHA-256-verified (no Go toolchain needed), cached under `~/.kit/tools/bumblebee/<version>/`
  - kit Action scans the checked-out repo in CI (`deep --root .`); local runs scan the machine baseline
  - Tunable via `KIT_BUMBLEBEE`, `KIT_NO_DOWNLOAD`, `KIT_BUMBLEBEE_PROFILE`, `KIT_BUMBLEBEE_ROOTS`, `KIT_BUMBLEBEE_BIN`, `KIT_BUMBLEBEE_CATALOG`
- Phase 5F: Public Launch & Community infrastructure
  - CODE_OF_CONDUCT.md for community standards
  - CHANGELOG.md for release tracking
  - COMMUNITY.md for contribution guidelines
  - GitHub issue templates for bug reports and feature requests
  - GitHub discussions setup guide
- Phase 5E: Security Framework & Hardening
  - SECURITY.md with comprehensive security audit checklist
  - SECURITY-HARDENING.md with pre-deployment verification procedures
  - SECURITY-SCANNING.md with automated security scanning pipeline
  - 5-stage security scanning (dependencies, SAST, DAST, containers, infrastructure)
  - GDPR and data protection compliance validation
  - Security incident response procedures
- Phase 5D: Load Testing & Performance
  - k6 load testing infrastructure with baseline, marketplace, and autoscaling tests
  - Database stress testing and connection pool validation
  - Bottleneck analysis methodology and optimization strategies
  - Capacity planning guide with 3 scaling scenarios and cost analysis
  - Kubernetes autoscaling validation test

### Changed
- Enhanced security monitoring and alerting infrastructure
- Improved deployment pipeline with security gates
- Extended monitoring capabilities with Prometheus metrics

### Fixed
- npm audit highs: fast-uri (path traversal + host confusion) and next 16.2.6
- pre-existing master CI failures
  - `src/run.test.ts`: isolated-env test now uses `process.execPath` (exit 127 → 0)
  - `src/audit-logging-service.test.ts`: 4 compliance-report window races (capture `end` after recording)
  - `Dockerfile`: dumb-init path /usr/sbin → /usr/bin; ENTRYPOINT includes node + cli so args pass through
  - `Dockerfile.marketplace`: drop redundant nginx-user (UID 101 conflict with built-in)
  - `marketplace-frontend`: add lucide-react dep; swap missing `ShieldStar` → `Award`; widen team-members `newRole` type
  - `docker-build.yml`: SHA-tag prefix bug (`:-<sha>`), GHA cache for PR builds (no creds), conditional Docker Hub push when DOCKER_* secrets absent, `pull-requests: write` for PR-comment step
- workflow shell-injection (Semgrep): `deploy-production.yml`, `deploy-staging.yml`, `action/action.yml` — untrusted inputs moved to step `env:`, tag/cmd allowlists added
- gitleaks false-positive on `${ENV_VAR}` placeholders in config files

### Security
- 65% Checkov reduction (166 → 58 terraform findings, 64 → 32 distinct check IDs) — see `.checkov.yaml` baseline header for fix log
  - SG descriptions, ECR `IMMUTABLE`, CW log KMS + 365d retention, S3 abort-multipart, EKS supported version 1.31, EKS Secrets envelope encryption, KMS key policies, VPC flow logs, default-SG lockdown, ELBv2 access logs, RDS Performance Insights KMS (per region), NLB log bucket hardening, public-subnet auto-IP off, EKS private-endpoint default, RDS replica deletion-protection + enhanced monitoring, SNS KMS, RDS IAM auth, Lambda X-Ray + DLQ + KMS, EC2 IMDSv2 + EBS-opt, CloudFront response-headers policy, scoped Lambda IAM, RDS SSL-required, copy_tags_to_snapshot
- DAST stage scoped out: kit is CLI + MCP-over-stdio with no HTTP surface to scan
- Comprehensive security scanning across all pipeline stages (Phase 5E carry-over)
- OWASP Top 10 vulnerability assessment and remediation
- Container vulnerability scanning with Trivy (CRITICAL+HIGH gating)
- Infrastructure-as-code security scanning (Checkov + tfsec) with baseline file
- Rate limiting and DDoS protection
- Security headers validation

## [1.0.0] - 2026-04-15

### Added
- Phase 5C: DevOps & Deployment Infrastructure
  - Multi-stage Docker containers for CLI and marketplace
  - Kubernetes manifests with Kustomize overlays for dev/staging/prod
  - Terraform modules for complete infrastructure-as-code
  - GitHub Actions workflows for Docker builds and Kubernetes deployments
  - Horizontal Pod Autoscaling (HPA) with CPU/memory triggers
  - Pod Disruption Budget (PDB) for high availability
  - Service mesh integration (optional)
  - Monitoring stack (Prometheus + Grafana)
  - Logging aggregation (Fluent-bit + CloudWatch/ELK)
  - Certificate management with cert-manager
- Phase 4: Integration & Developer Experience
  - Sentry integration for error tracking
  - Datadog integration for APM and monitoring
  - Redis adapter for caching
  - CDN adapter for static asset acceleration
  - Testing framework enhancements
  - Error handling and recovery patterns
- Phase 3E: Author Dashboard
  - Backend implementation with 43 new tests
  - Frontend with 6 components and 4 pages
  - Community features foundation
- Phase 3: Marketplace
  - 4 core marketplace components (marketplace, storefront, listings, reviews)
  - 716 comprehensive tests
  - Plugin review and rating system
  - Search and filtering capabilities
  - User profiles and favorites
- Phase 2: Plugin Ecosystem
  - 10 ecosystem components (registry, resolver, security validator, etc.)
  - Plugin manifests and versioning
  - Dependency resolution
  - Security scanning
  - Plugin marketplace integration
- Phase 1: Core CLI
  - kit command-line interface
  - Tool management (mise-en-place integration)
  - Secret management (1Password integration)
  - Project setup and initialization
  - Configuration management (.kit.toml)

### Security
- Implemented comprehensive security framework (OWASP Top 10)
- Added dependency vulnerability scanning
- Enabled container image scanning
- Infrastructure security hardening
- GDPR and data protection compliance

---

## Release History Summary

| Version | Date | Phase | Highlights |
|---------|------|-------|-----------|
| 1.0.0 | 2026-04-15 | 5C | DevOps & Deployment Infrastructure |
| - | In Progress | 5F | Public Launch & Community |

## Semantic Versioning

### Version Format: MAJOR.MINOR.PATCH

- **MAJOR** — Breaking changes (incompatible API changes)
- **MINOR** — New features (backward compatible)
- **PATCH** — Bug fixes (backward compatible)

### Examples
- 1.0.0 → 1.1.0: New feature added
- 1.0.0 → 1.0.1: Bug fix
- 1.0.0 → 2.0.0: Breaking change

## Release Process

### Before Each Release

1. Update CHANGELOG.md with changes since last release
2. Update version number in package.json
3. Create git tag: `git tag -a v1.0.0 -m "Release 1.0.0"`
4. Push tag: `git push origin v1.0.0`
5. GitHub Actions automatically builds and publishes

### Release Naming

- **Alpha (α)** — Early development, breaking changes expected
  - Example: v1.0.0-alpha.1
  - Testing by developers only
  
- **Beta (β)** — Feature-complete, bug fixes and polish
  - Example: v1.0.0-beta.1
  - Limited community testing
  
- **Release Candidate (RC)** — Preparation for release
  - Example: v1.0.0-rc.1
  - Final testing before release
  
- **Stable (Release)** — Production-ready
  - Example: v1.0.0
  - Recommended for production use

## Long-Term Support (LTS)

- **Current stable:** v1.x.x (released 2026-04-15)
- **Support period:** Until next major version (typically 12+ months)
- **Security updates:** Available throughout support period

## Migration Guides

- [Upgrading from Phase 4 to Phase 5](docs/MIGRATION_GUIDE.md)
- [Breaking Changes in v2.0.0](docs/API_STABILITY_AND_VERSIONING.md) (future)

## Contributors

Special thanks to all contributors who have helped shape kit:

- [View Contributors](https://github.com/sandstream/kit/graphs/contributors)

## Reporting Issues

Found a bug? Have a feature request? Please see our [CONTRIBUTING.md](CONTRIBUTING.md) guide.

---

**Note:** This changelog is maintained manually and should be updated with each release. Unreleased changes are accumulated and released with the next version.
