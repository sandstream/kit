# kit Security Hardening Checklist

## Pre-Deployment Security Verification

### Stage 1: Code Security (Before Commit)

- [ ] No hardcoded secrets (passwords, API keys, tokens)
- [ ] No sensitive data in comments
- [ ] Dependencies audit passed (`npm audit`)
- [ ] No outdated packages with known vulnerabilities
- [ ] SonarQube scan passed (no critical/high issues)
- [ ] Code review completed by security reviewer
- [ ] Security tests pass (input validation, injection prevention)

**Verification Command:**
```bash
npm audit
npm run security-scan  # SonarQube
npm run security-test  # Security-focused tests
```

### Stage 2: Container Security (Before Push)

- [ ] Docker image scanned for vulnerabilities (Trivy)
- [ ] Base image updated to latest
- [ ] No secrets in Docker image
- [ ] Non-root user configured
- [ ] Health checks configured
- [ ] Resource limits set
- [ ] Read-only root filesystem where possible

**Verification Commands:**
```bash
# Scan image
trivy image kit:latest

# Check for secrets
docker inspect kit:latest | grep -i "secret\|password"

# Verify non-root
docker inspect --format='{{json .Config.User}}' kit:latest
```

### Stage 3: Kubernetes Security (Before Deploy)

- [ ] Network policies deployed
- [ ] Pod security policy enforced
- [ ] RBAC roles configured (least privilege)
- [ ] Resource requests/limits set
- [ ] Liveness/readiness probes configured
- [ ] Security context applied
- [ ] Secrets encrypted at rest
- [ ] Service account created (not default)

**Verification Commands:**
```bash
# Check network policies
kubectl get networkpolicies -n kit

# Verify security context
kubectl get pods -n kit -o jsonpath='{.items[*].spec.securityContext}'

# Check RBAC
kubectl get rolebindings -n kit
kubectl get clusterrolebindings | grep kit
```

### Stage 4: Infrastructure Security (Before Production)

- [ ] TLS certificates valid
- [ ] Certificate auto-renewal configured
- [ ] Security groups properly configured
- [ ] WAF rules deployed
- [ ] DDoS protection enabled
- [ ] VPN access for admin operations
- [ ] Encryption keys rotated recently
- [ ] Backups tested and restorable
- [ ] Disaster recovery plan documented

**AWS Verification:**
```bash
# Check security groups
aws ec2 describe-security-groups --filters Name=group-name,Values=kit-*

# Verify TLS certificates
aws acm describe-certificate --certificate-arn <cert-arn>

# Check backup status
aws rds describe-db-instances --query 'DBInstances[*].[DBInstanceIdentifier,LatestRestorableTime]'
```

---

## Security Configuration Guide

### 1. Environment Variables (kit Configuration)

**Never commit:**
- Database passwords
- API keys
- Secret tokens
- Private certificates

**Store in:**
- AWS Secrets Manager (production)
- 1Password (team sharing)
- Local .env file (local development, git-ignored)

**Example .env (local):**
```bash
# Database
DB_PASSWORD=dev_password_12345

# API Keys
STRIPE_SECRET_KEY=sk_test_...
GITHUB_API_TOKEN=ghp_...

# JWT
JWT_SECRET=your_secret_key_change_in_production

# Third-party services
SENTRY_DSN=https://...
```

### 2. Application Security Headers

**Configure in application:**
```javascript
// Express + Helmet
const helmet = require('helmet');

app.use(helmet());

// Custom security headers
app.use((req, res, next) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  next();
});
```

### 3. Kubernetes Security Context

**Pod Security:**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kit-secure
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  
  containers:
  - name: app
    image: kit:latest
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      capabilities:
        drop:
        - ALL
    
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: cache
      mountPath: /app/cache
  
  volumes:
  - name: tmp
    emptyDir: {}
  - name: cache
    emptyDir: {}
```

### 4. Database Security

**PostgreSQL Hardening:**
```sql
-- Create limited user (not superuser)
CREATE USER kit_app WITH PASSWORD 'secure_password';

-- Grant only necessary permissions
GRANT CONNECT ON DATABASE kit TO kit_app;
GRANT USAGE ON SCHEMA public TO kit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kit_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kit_app;

-- Enable SSL/TLS
ALTER SYSTEM SET ssl = on;

-- Require password for non-superuser
ALTER SYSTEM SET password_encryption = 'scram-sha-256';

-- Limit concurrent connections
ALTER SYSTEM SET max_connections = 100;

-- Enable query logging
ALTER SYSTEM SET log_statement = 'all';
ALTER SYSTEM SET log_min_duration_statement = 0;

-- Reload configuration
SELECT pg_reload_conf();
```

### 5. S3 Bucket Security

**AWS S3 Configuration:**
```javascript
// S3 bucket policy - restrict access
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnencryptedObjectUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::kit-*/*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "aws:kms"
        }
      }
    },
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::kit-*",
        "arn:aws:s3:::kit-*/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    }
  ]
}
```

### 6. Network Security

**WAF Rules (AWS WAF):**
```json
{
  "Name": "kit-waf-rules",
  "Rules": [
    {
      "Name": "RateLimitRule",
      "Priority": 1,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 2000,
          "AggregateKeyType": "IP"
        }
      },
      "Action": { "Block": {} },
      "VisibilityConfig": { "SampledRequestsEnabled": true }
    },
    {
      "Name": "AWSManagedRulesCommonRuleSet",
      "Priority": 2,
      "OverrideAction": { "None": {} },
      "Statement": {
        "ManagedRuleGroupStatement": {
          "Vendor": "AWS",
          "Name": "AWSManagedRulesCommonRuleSet"
        }
      }
    }
  ]
}
```

---

## Security Testing Guide

### 1. OWASP ZAP Scanning

**Installation:**
```bash
docker pull owasp/zap2docker-stable
```

**Baseline Scan:**
```bash
docker run -t owasp/zap2docker-stable zap-baseline.py \
  -t https://kit.local \
  -r report.html \
  -J report.json
```

**Full Scan:**
```bash
docker run -t owasp/zap2docker-stable zap-full-scan.py \
  -t https://kit.local \
  -r report.html \
  -J report.json \
  -x report.xml
```

### 2. Burp Suite Testing

**Key Tests:**
- SQL injection attempts on all input fields
- XSS payloads in comments and user inputs
- CSRF token validation
- Authentication bypass attempts
- Authorization boundary testing
- Session management testing
- Cookie security (HttpOnly, Secure, SameSite)
- API endpoint testing

### 3. Dependency Scanning

**npm Audit:**
```bash
# Check for vulnerabilities
npm audit

# Fix automatically (caution - may break compatibility)
npm audit fix

# Fix only safe updates
npm audit fix --audit-level=moderate
```

**Snyk:**
```bash
npm install -g snyk
snyk auth
snyk test
snyk monitor  # Continuous monitoring
```

### 4. Container Scanning

**Trivy:**
```bash
# Scan image
trivy image kit:latest

# Generate JSON report
trivy image --format json --output report.json kit:latest

# Only fail on critical vulnerabilities
trivy image --exit-code 1 --severity CRITICAL kit:latest
```

### 5. Infrastructure Scanning

**Kubernetes Security Scanning:**
```bash
# Kubesec scoring
kubectl get pod -o json | kubesec scan

# Network policy validation
kubectl describe networkpolicies

# RBAC audit
kubectl auth can-i create pods --as=system:serviceaccount:kit:default
```

---

## Security Incident Response

### Detection Signals

**Watch for:**
- Unexpected API calls from unusual IPs
- Failed login attempts exceeding threshold
- SQL/XSS pattern in request logs
- Privilege escalation attempts
- Unusual data access patterns
- Spike in error rates
- Slow query performance
- Disk space exhaustion
- Memory leaks
- Certificate expiration warnings

### Response Checklist

```
IMMEDIATE (0-1 hour):
[ ] Verify incident authenticity
[ ] Isolate affected systems
[ ] Enable detailed logging
[ ] Collect evidence (logs, memory dumps)
[ ] Notify security team
[ ] Start incident clock

SHORT-TERM (1-4 hours):
[ ] Root cause analysis
[ ] Patch/fix applied
[ ] Changes verified in test environment
[ ] Notify stakeholders
[ ] Prepare customer communication

MEDIUM-TERM (4-24 hours):
[ ] Deploy fix to production
[ ] Monitor for reinfection
[ ] Forensic analysis complete
[ ] Lessons learned documented
[ ] Customers notified (if necessary)

LONG-TERM (1+ weeks):
[ ] Post-mortem meeting
[ ] Policy updates
[ ] Prevention measures implemented
[ ] Training for team
[ ] Update runbooks
```

---

## Security Checklist by Release

### Before Beta Release

- [ ] Security documentation complete
- [ ] OWASP Top 10 assessment done
- [ ] Dependencies audited
- [ ] Container images scanned
- [ ] Basic penetration testing passed
- [ ] Security headers configured
- [ ] Rate limiting enabled
- [ ] Logging configured
- [ ] Incident response plan drafted

### Before Production Release

- [ ] Full security audit completed
- [ ] OWASP ZAP scan clean
- [ ] Burp Suite testing passed
- [ ] Third-party security review (optional)
- [ ] GDPR compliance verified
- [ ] Data protection impact assessment done
- [ ] Encryption keys generated and stored
- [ ] Backup and restore tested
- [ ] Monitoring and alerting active
- [ ] Incident response team trained
- [ ] Security incident reporting process documented
- [ ] Insurance reviewed (cyber liability)

---

## Compliance Certifications

### Target Certifications

- [ ] SOC 2 Type II (within 12 months)
- [ ] ISO 27001 (within 18 months)
- [ ] GDPR Compliant (before EU expansion)
- [ ] CCPA Compliant (if serving California)
- [ ] PCI-DSS (if processing payments)

### Annual Requirements

- [ ] Penetration testing (professional firm)
- [ ] Security training (all team members)
- [ ] Disaster recovery drill
- [ ] Incident response simulation
- [ ] Security audit
- [ ] Compliance review

---

## References

- [OWASP Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [AWS Security Best Practices](https://docs.aws.amazon.com/security/)
- [Kubernetes Security](https://kubernetes.io/docs/concepts/security/)
- [GDPR Requirements](https://gdpr-info.eu/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

---

**Last Updated:** 2026-04-15  
**Version:** 1.0  
**Maintained By:** Security Team
