# kit Security Scanning & Continuous Compliance

Automated security scanning and compliance validation for kit CI/CD pipeline.

## Security Scanning Pipeline

### Stage 1: Dependency Scanning (Pre-commit)

**Tool:** `npm audit` + Snyk

**Configuration:**
```bash
# .pre-commit-config.yaml
- repo: npm
  hooks:
  - id: npm-audit
    stages: [commit]
    args: ["--audit-level=moderate"]
```

**GitHub Actions Workflow:**
```yaml
name: Dependency Scan
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: npm audit
        run: npm audit --audit-level=moderate
      
      - name: Snyk scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high
```

**Passing Criteria:**
- ✓ Zero critical vulnerabilities
- ✓ High vulnerabilities reviewed and mitigated
- ✓ All dependencies up-to-date

---

### Stage 1b: Supply-chain Exposure Scanning

**Tool:** [`bumblebee`](https://github.com/perplexityai/bumblebee) — managed automatically by kit.

Where `npm audit` / Snyk flag *known CVEs*, bumblebee flags *known compromises*: installed packages whose exact `(ecosystem, name, version)` matches a curated incident catalog (Shai-Hulud worm, typosquats, credential stealers, malicious editor/browser extensions, hijacked MCP servers). It is a read-only, on-disk inventory scanner — it never runs package managers or executes project code.

**How kit ships it (no Go toolchain required):**
- The pinned release binary is downloaded from GitHub Releases, verified against a SHA-256 embedded in kit (`src/bumblebee.ts` → `TARBALL_CHECKSUMS`), and cached under `~/.kit/tools/bumblebee/<version>/`.
- The release bundles the official `threat_intel/` exposure catalogs; kit points `--exposure-catalog` at them.
- The check runs as part of `kit check` and `kit ci` (category `supply-chain`). It **never fails CI on infrastructure problems** — an unreachable download or unsupported platform downgrades to a `warn`. A `fail` means an actual catalog match.

**Default scope:**
- **Local (`kit check`):** `baseline` profile — global/user package roots, language toolchains, editor + browser extensions, and MCP configs. This is the surface `npm audit` does *not* cover.
- **CI (`kit ci` via the kit Action):** `deep --root .` — scans the checked-out repository instead of the runner's machine image. Pre-wired in `action/action.yml`.

**Environment knobs:**

| Variable | Effect |
|----------|--------|
| `KIT_BUMBLEBEE=0` | Skip the check entirely |
| `KIT_NO_DOWNLOAD=1` | Never fetch the binary (warn if not already cached) |
| `KIT_BUMBLEBEE_PROFILE` | `baseline` (default) \| `project` \| `deep` |
| `KIT_BUMBLEBEE_ROOTS` | Comma-separated roots, e.g. `.` for the repo (required for `deep`) |
| `KIT_BUMBLEBEE_BIN` | Use a pre-installed bumblebee instead of downloading |
| `KIT_BUMBLEBEE_CATALOG` | Override the exposure-catalog directory |

**Passing Criteria & failure handling:**
- ✓ `pass` — zero catalog matches, scan completed (`scan_summary.status == "complete"`, not timed out)
- ✗ `fail` — one or more catalog matches (`record_type=finding`)
- ✗ `fail` (high) — **integrity check failed**: the downloaded binary did not match its pinned SHA-256. Treated as a potential tampering event, never as "unavailable". Do not trust the binary; clear `~/.kit/tools/bumblebee` and retry from a trusted network.
- ⚠ `warn` — scanner unreachable / unsupported platform / incomplete scan (fails *open* so flaky networks don't break CI)
- ⚠ `warn` — clean scan but **threat-intel catalogs older than 60 days** (frozen catalogs lose coverage; bump the pinned version)

**Strict pipelines:** the check fails open to `warn` by design. To make a missing/incomplete scanner block the build, set the kit Action's `fail-on-warning: true` (or pass `--fail-on-warning`), which promotes warnings to a non-zero exit. Integrity failures already `fail` regardless.

> **Bumping the pinned version:** update `BUMBLEBEE_VERSION` **and** `TARBALL_CHECKSUMS` in `src/bumblebee.ts` together, copying digests from the release's `checksums.txt`. The two must move in lockstep — this also refreshes the bundled exposure catalogs.

---

### Stage 2: Static Application Security Testing (SAST)

**Tool:** SonarQube + ESLint Security Plugin

**Local Setup:**
```bash
npm install -D sonarqube-scanner
npm install -D eslint-plugin-security
npm install -D @snyk/cli

# Run locally
npx sonar-scanner
npx eslint --plugin security src/**/*.js
npx snyk test --severity-threshold=high
```

**GitHub Actions:**
```yaml
name: SAST Scan
on: [push, pull_request]

jobs:
  sonar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - name: SonarQube Scan
        uses: SonarSource/sonarcloud-github-action@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        with:
          args: >
            -Dsonar.sources=src/
            -Dsonar.tests=src/__tests__/
            -Dsonar.javascript.lcov.reportPaths=coverage/lcov.info
      
      - name: ESLint Security
        run: npx eslint --ext .js,.ts --plugin security src/
      
      - name: Check Quality Gate
        run: |
          quality_gate=$(curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=$SONAR_PROJECT" \
            -H "Authorization: Bearer $SONAR_TOKEN" | jq -r '.projectStatus.status')
          if [ "$quality_gate" != "OK" ]; then
            echo "SonarQube Quality Gate failed"
            exit 1
          fi
```

**Quality Gates:**
- ✓ Code coverage ≥ 80%
- ✓ No high-priority code smells
- ✓ No security hotspots
- ✓ All OWASP issues addressed

---

### Stage 3: Dynamic Application Security Testing (DAST)

**Tool:** OWASP ZAP

**Docker Setup:**
```bash
docker pull owasp/zap2docker-stable
docker run -t owasp/zap2docker-stable zap-baseline.py \
  -t https://kit-staging.local \
  -r zap-report.html \
  -x zap-report.xml
```

**GitHub Actions (Staging):**
```yaml
name: DAST Scan
on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:

jobs:
  dast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Deploy to staging
        run: |
          kubectl apply -f kubernetes/overlays/staging
          kubectl rollout status deployment/kit -n kit --timeout=5m
      
      - name: OWASP ZAP Baseline
        uses: zaproxy/action-baseline@v0.7.0
        with:
          target: 'https://kit-staging.local'
          rules_file_name: '.zap/rules.tsv'
          cmd_options: '-a'
      
      - name: Upload Report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: zap-report
          path: report_md.md
      
      - name: Check Results
        run: |
          if [ -f report_md.md ]; then
            if grep -q "FAIL" report_md.md; then
              echo "DAST scan failed"
              exit 1
            fi
          fi
```

**Passing Criteria:**
- ✓ No critical vulnerabilities
- ✓ High vulnerabilities reviewed
- ✓ Default alerts disabled

---

### Stage 4: Container Scanning

**Tool:** Trivy

**Local:**
```bash
trivy image kit:latest
trivy image --format json --output report.json kit:latest
trivy image --severity CRITICAL,HIGH kit:latest
```

**GitHub Actions:**
```yaml
name: Container Scan
on:
  push:
    branches: [main]
  pull_request:

jobs:
  trivy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build image
        run: docker build -t kit:${{ github.sha }} .
      
      - name: Trivy scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: kit:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'
      
      - name: Upload Trivy results
        uses: github/codeql-action/upload-sarif@v2
        if: always()
        with:
          sarif_file: 'trivy-results.sarif'
      
      - name: Check critical issues
        run: |
          trivy image kit:${{ github.sha }} \
            --exit-code 1 \
            --severity CRITICAL
```

**Passing Criteria:**
- ✓ Zero critical CVEs
- ✓ High CVEs documented
- ✓ Base image updated

---

### Stage 5: Infrastructure Scanning

**Tool:** Checkov + tfsec

**Local:**
```bash
# Install tools
npm install -g checkov
npm install -g tfsec

# Scan Terraform
checkov -d terraform/
tfsec terraform/

# Scan Kubernetes
checkov -d kubernetes/ --framework kubernetes
kubesec scan kubernetes/base/deployment.yml
```

**GitHub Actions:**
```yaml
name: Infrastructure Scan
on: [push, pull_request]

jobs:
  checkov:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Checkov scan
        uses: bridgecrewio/checkov-action@master
        with:
          directory: .
          framework: terraform,kubernetes,dockerfile
          quiet: false
          soft_fail: false
          skip_check: CKV_DOCKER_3  # Example: skip specific check
      
      - name: tfsec scan
        uses: aquasecurity/tfsec-action@v1.0.0
        with:
          working_directory: 'terraform/'
          format: 'sarif'
          out: 'tfsec.sarif'
      
      - name: Upload tfsec results
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'tfsec.sarif'
```

**Passing Criteria:**
- ✓ No critical misconfigurations
- ✓ Security best practices followed
- ✓ Encryption enabled
- ✓ Network segmentation configured

---

## Compliance Validation

### GDPR Compliance Check

**Validation Script:**
```bash
#!/bin/bash
# gdpr-compliance-check.sh

echo "=== GDPR Compliance Validation ==="

# 1. Check privacy policy
if [ ! -f "PRIVACY.md" ]; then
    echo "❌ Privacy policy missing"
    exit 1
fi

# 2. Check data deletion capability
if ! grep -q "right_to_be_forgotten\|deleteUserData" src/**/*.js; then
    echo "❌ Data deletion functionality not found"
    exit 1
fi

# 3. Check consent management
if ! grep -q "consent\|recordConsent" src/**/*.js; then
    echo "❌ Consent management not implemented"
    exit 1
fi

# 4. Check data export
if ! grep -q "exportUserData\|GDPR" src/**/*.js; then
    echo "❌ Data export functionality not found"
    exit 1
fi

# 5. Check encryption
if ! grep -q "encrypt\|KMS" terraform/**/*.tf; then
    echo "❌ Encryption not configured in infrastructure"
    exit 1
fi

echo "✅ GDPR compliance checks passed"
```

**GitHub Actions:**
```yaml
name: GDPR Compliance
on: [push, pull_request]

jobs:
  gdpr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: GDPR Compliance Check
        run: bash scripts/gdpr-compliance-check.sh
      
      - name: Check Privacy Policy
        run: |
          if [ ! -f "PRIVACY.md" ]; then
            echo "Privacy policy required"
            exit 1
          fi
          
          # Verify required sections
          for section in "Data Collection" "Data Usage" "User Rights" "Security"; do
            if ! grep -q "$section" PRIVACY.md; then
              echo "Missing section: $section"
              exit 1
            fi
          done
```

---

### Security Headers Validation

**Test Script:**
```bash
#!/bin/bash
# validate-security-headers.sh

HOST="${1:-https://kit.local}"

echo "Checking security headers for $HOST..."

# Required headers
headers=(
  "Strict-Transport-Security"
  "X-Content-Type-Options"
  "X-Frame-Options"
  "Content-Security-Policy"
  "X-XSS-Protection"
  "Referrer-Policy"
)

for header in "${headers[@]}"; do
    response=$(curl -s -I "$HOST" | grep -i "^$header")
    if [ -z "$response" ]; then
        echo "❌ Missing header: $header"
        exit 1
    else
        echo "✅ $response"
    fi
done

echo "✅ All security headers present"
```

**GitHub Actions:**
```yaml
name: Security Headers Check
on:
  schedule:
    - cron: '0 * * * *'  # Hourly
  workflow_dispatch:

jobs:
  headers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Check staging headers
        run: bash scripts/validate-security-headers.sh https://kit-staging.local
      
      - name: Check production headers
        if: github.ref == 'refs/heads/main'
        run: bash scripts/validate-security-headers.sh https://kit.example.com
```

---

### Certificate Validation

**Monitoring:**
```bash
#!/bin/bash
# check-certificates.sh

echo "=== Certificate Validation ==="

# Check TLS certificate expiration
for domain in kit.local kit.example.com; do
    cert_date=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null | \
        openssl x509 -noout -enddate | cut -d= -f2)
    
    expiry_epoch=$(date -d "$cert_date" +%s)
    current_epoch=$(date +%s)
    days_left=$(( (expiry_epoch - current_epoch) / 86400 ))
    
    if [ $days_left -lt 30 ]; then
        echo "⚠️  Certificate expires in $days_left days: $domain"
        # Send alert
        curl -X POST https://alerts.example.com/slack \
            -d "Certificate for $domain expires in $days_left days"
    else
        echo "✅ $domain: $days_left days remaining"
    fi
done
```

**GitHub Actions:**
```yaml
name: Certificate Check
on:
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight

jobs:
  certs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Check certificates
        run: bash scripts/check-certificates.sh
      
      - name: Alert on expiration
        if: failure()
        uses: 8398a7/action-slack@v3
        with:
          status: custom
          custom_payload: |
            {
              text: 'Certificate expiration warning',
              attachments: [{
                color: 'warning',
                text: 'Check certificate expiration'
              }]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

---

## Vulnerability Management

### Vulnerability Triage Process

**Severity Levels:**

| Level | Response Time | Action |
|-------|---------------|--------|
| Critical | 1 hour | Immediate patch, emergency deploy |
| High | 1 day | Schedule patch, test thoroughly |
| Medium | 7 days | Plan update, review impact |
| Low | 30 days | Quarterly review, batch updates |

### Vulnerability Response Workflow

**1. Disclosure & Assessment**
```
Report received
    ↓
Verify authenticity
    ↓
Assess severity
    ↓
Identify affected versions
    ↓
Determine impact
```

**2. Remediation**
```
Patch available
    ↓
Apply to dev environment
    ↓
Run security tests
    ↓
Deploy to staging
    ↓
Monitor for issues
    ↓
Deploy to production
```

**3. Post-Disclosure**
```
Monitor for exploitation
    ↓
Document lessons learned
    ↓
Update security policies
    ↓
Notify users (if needed)
```

---

## Security Dashboards & Alerts

### Prometheus Metrics

**Security metrics to track:**
```yaml
# Custom metrics
kit_failed_login_attempts
kit_unauthorized_api_calls
kit_sql_injection_attempts
kit_xss_attempts
kit_security_scan_findings
kit_vulnerability_count
kit_certificate_days_to_expiry
```

**Prometheus Rules:**
```yaml
groups:
- name: security
  rules:
  - alert: HighFailedLoginAttempts
    expr: rate(kit_failed_login_attempts[5m]) > 10
    for: 5m
    annotations:
      summary: "High failed login attempts"
  
  - alert: SQLInjectionAttempt
    expr: increase(kit_sql_injection_attempts[5m]) > 0
    for: 1m
    annotations:
      summary: "SQL injection attempt detected"
  
  - alert: CertificateExpiringSoon
    expr: kit_certificate_days_to_expiry < 30
    annotations:
      summary: "Certificate expires in {{ $value }} days"
  
  - alert: CriticalVulnerabilityFound
    expr: kit_vulnerability_count{severity="critical"} > 0
    for: 1m
    annotations:
      summary: "Critical vulnerability found"
```

### Grafana Dashboard

**Dashboard panels:**
1. Security scan results (pass/fail timeline)
2. Vulnerability count by severity
3. Failed login attempts (24h)
4. API authorization failures (24h)
5. Certificate expiry countdown
6. Deployment security gate status
7. Incident response time SLA

---

## Continuous Integration Security Checklist

**Pre-Merge Requirements:**
- [ ] Code review completed
- [ ] SAST scan passed
- [ ] Dependency audit passed
- [ ] Container scan passed
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Security tests pass

**Pre-Deploy Requirements (Staging):**
- [ ] All pre-merge checks passed
- [ ] DAST scan passed
- [ ] Infrastructure scan passed
- [ ] Security headers present
- [ ] Encryption enabled
- [ ] Monitoring configured

**Pre-Deploy Requirements (Production):**
- [ ] 48-hour staging soak test
- [ ] Staging DAST passed
- [ ] No critical findings
- [ ] Security team approval
- [ ] Change log reviewed
- [ ] Rollback plan documented

---

## Reporting & Audit Trail

### Security Report Template

```markdown
# Security Report - [Date]

## Executive Summary
- Total vulnerabilities: X
- Critical: X, High: X, Medium: X, Low: X
- Trend: [improving/degrading/stable]

## Vulnerabilities
- [Critical findings]
- [High findings]
- [Resolution status]

## Compliance Status
- GDPR: [Compliant/Non-compliant]
- CCPA: [Compliant/Non-compliant]
- OWASP Top 10: [Assessment results]

## Recommendations
1. [Action item 1]
2. [Action item 2]
3. [Action item 3]

## Sign-off
- Security Lead: ____
- Engineering Lead: ____
- Date: ____
```

---

**Last Updated:** 2026-04-15  
**Version:** 1.0
