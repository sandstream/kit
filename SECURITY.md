# kit Security Framework & Hardening Guide

## Reporting a vulnerability

If you believe you've found a security issue in `sandstream-kit`, **please do not open a public issue**. Instead:

1. Email: **hello@sandstre.am**
2. Subject line should include "kit-security" and a brief description
3. Include: affected version, reproduction steps, suggested severity, your contact preference
4. We aim to acknowledge within 72 hours and provide a remediation timeline within 7 days for confirmed issues

Coordinated disclosure: we'll publish a CVE + advisory after the fix is released. Reporter attribution by default unless you prefer anonymity.

## Threat model + data flow

The trust model is documented in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and the data flows in [`docs/DATA_FLOW.md`](docs/DATA_FLOW.md). Key claims:
- No central server, no default telemetry — kit is a local CLI
- API tokens stay in user-controlled vaults (1Password / Infisical / Bitwarden / etc); kit reads them at point-of-use
- Audit log is local JSONL by default; remote (Remote) is opt-in via `[audit].remote = true`
- Bumblebee supply-chain scanner: binary pinned by SHA-256, exposure catalog signed by upstream

## Overview

This document provides a comprehensive security framework for kit, covering vulnerability assessment, hardening guidelines, compliance requirements, and incident response procedures.

## Table of Contents

1. [Reporting a vulnerability](#reporting-a-vulnerability)
2. [Threat model + data flow](#threat-model--data-flow)
3. [Security Audit Checklist](#security-audit-checklist)
4. [OWASP Top 10 Assessment](#owasp-top-10-assessment)
5. [Infrastructure Security](#infrastructure-security)
6. [Application Security](#application-security)
7. [Compliance & Data Protection](#compliance--data-protection)
8. [Incident Response Plan](#incident-response-plan)

---

## Security Audit Checklist

### Phase 1: Dependency & Supply Chain Security

**Objective:** Ensure all third-party dependencies are secure and up-to-date.

**Actions:**
```bash
# Audit npm dependencies
npm audit
npm audit fix
npm audit fix --audit-level=moderate

# Check outdated packages
npm outdated

# Verify lock file integrity
npm ci --frozen-lockfile

# Scan for vulnerable dependencies
npx npm-check-updates -u
```

**Checklist:**
- [ ] All critical vulnerabilities fixed
- [ ] High vulnerabilities reviewed and mitigated
- [ ] Medium vulnerabilities documented with risk acceptance
- [ ] Lock files committed to version control
- [ ] Automated dependency scanning enabled in CI/CD
- [ ] License compliance verified (no GPL/AGPL conflicts)

**Expected Result:** Zero critical/high severity vulnerabilities

### Phase 2: Code-Level Security

**Objective:** Identify and fix code-level security issues.

**Actions:**
```bash
# Use SonarQube or similar
npm install -D sonarqube-scanner

# Run security linting
npm install -D @snyk/cli
snyk test
snyk test --severity-threshold=high

# Code quality and security
npm install -D eslint-plugin-security
npx eslint --ext .js,.ts src/
```

**Checklist:**
- [ ] No hardcoded secrets/credentials in code
- [ ] SQL injection prevention validated
- [ ] XSS protection implemented
- [ ] CSRF tokens present
- [ ] Input validation on all user inputs
- [ ] Output encoding applied correctly
- [ ] No insecure cryptography
- [ ] No insecure randomness generation
- [ ] Security headers properly configured

**Expected Result:** Code security scan passes with 0 high-risk findings

### Phase 3: Infrastructure Security

**Objective:** Verify infrastructure is hardened against attacks.

**Checklist:**
- [ ] TLS/HTTPS enforced everywhere
- [ ] Certificate validity and rotation verified
- [ ] Security groups restrict traffic properly
- [ ] Network policies enabled in Kubernetes
- [ ] Pod security policies enforced
- [ ] RBAC roles follow least-privilege principle
- [ ] Secrets encrypted at rest
- [ ] Secrets not logged or exposed in error messages
- [ ] Rate limiting configured
- [ ] DDoS protection enabled
- [ ] WAF (Web Application Firewall) enabled
- [ ] Logging and monitoring enabled

**Expected Result:** Infrastructure passes security audit

### Phase 4: Compliance Review

**Objective:** Ensure compliance with regulations and standards.

**Checklist:**
- [ ] GDPR compliance assessment complete
- [ ] Data retention policies implemented
- [ ] User consent collection verified
- [ ] Right to be forgotten implementation
- [ ] Data breach notification procedures established
- [ ] Privacy policy up-to-date
- [ ] Terms of service reviewed
- [ ] Audit logging complete
- [ ] PCI DSS compliance (if processing payments)
- [ ] CCPA compliance (if serving California residents)

**Expected Result:** Compliance report generated and signed off

---

## OWASP Top 10 Assessment

### 1. Broken Access Control

**Risk:** Unauthorized users accessing restricted resources.

**kit Assessment:**
- [ ] Authentication enforced on all protected endpoints
- [ ] Authorization checks on every action
- [ ] Role-based access control (RBAC) implemented
- [ ] No user can escalate privileges
- [ ] Horizontal privilege escalation prevented

**Mitigation:**
```javascript
// Middleware for authorization
async function authorizeAction(req, res, next) {
  const user = req.user;
  const resource = req.params.id;
  
  const hasPermission = await checkPermission(user.id, 'action', resource);
  if (!hasPermission) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  next();
}
```

**Validation:** All API endpoints tested with unauthorized users

---

### 2. Cryptographic Failures

**Risk:** Sensitive data exposed due to weak or missing encryption.

**kit Assessment:**
- [ ] All data in transit encrypted (TLS 1.2+)
- [ ] Sensitive data encrypted at rest (KMS)
- [ ] No sensitive data in logs
- [ ] Passwords hashed with strong algorithm (bcrypt/Argon2)
- [ ] Tokens have short expiration times
- [ ] Secure random number generation used

**Mitigation:**
```javascript
// Use bcrypt for password hashing
const bcrypt = require('bcrypt');

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// Verify password
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Use KMS for secrets
async function encryptSecret(secret, kmsKeyId) {
  const result = await kms.encrypt({
    KeyId: kmsKeyId,
    Plaintext: secret,
  }).promise();
  return result.CiphertextBlob;
}
```

**Validation:** Encryption audit and penetration testing

---

### 3. Injection

**Risk:** Malicious code executed through unsanitized input.

**Sub-categories:** SQL Injection, NoSQL Injection, Command Injection, OS Injection

**kit Assessment:**
- [ ] Parameterized queries used for all database access
- [ ] No string concatenation in SQL queries
- [ ] Input validation on all user inputs
- [ ] Output encoding applied
- [ ] ORM/Query builders prevent injection
- [ ] No command execution from user input

**Mitigation:**

**SQL Injection Prevention:**
```javascript
// ✓ Safe: Parameterized query
db.query('SELECT * FROM users WHERE email = $1', [userEmail]);

// ✗ Unsafe: String concatenation
db.query(`SELECT * FROM users WHERE email = '${userEmail}'`);

// ✓ Safe: ORM usage
User.findByEmail(userEmail);
```

**Input Validation:**
```javascript
// Validate and sanitize input
const { body, validationResult } = require('express-validator');

app.post('/api/users', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).trim().escape(),
  body('name').trim().escape().isLength({ min: 1, max: 100 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  // Process validated input
});
```

**Command Injection Prevention:**
```javascript
// ✓ Safe: Use child_process with array arguments
const { execFile } = require('child_process');
execFile('command', [arg1, arg2], (error, stdout) => {
  // Process output
});

// ✗ Unsafe: Shell interpolation
const { exec } = require('child_process');
exec(`command ${userInput}`); // VULNERABLE!
```

**Validation:** DAST (Dynamic Application Security Testing) scan

---

### 4. Insecure Design

**Risk:** Missing security controls by design.

**kit Assessment:**
- [ ] Threat modeling completed
- [ ] Security requirements documented
- [ ] Principle of least privilege applied
- [ ] Defense in depth implemented
- [ ] Rate limiting configured
- [ ] Account lockout after failed attempts

**Mitigation:**
```javascript
// Rate limiting
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many login attempts, try again later',
  skipSuccessfulRequests: true,
});

app.post('/api/login', loginLimiter, (req, res) => {
  // Login logic
});

// Account lockout
async function recordFailedLogin(userId) {
  const failures = await redis.incr(`login_failures:${userId}`);
  
  if (failures >= 5) {
    await User.update(userId, { locked: true });
    await sendSecurityAlert(userId, 'Account locked due to failed logins');
  }
  
  // Expire after 1 hour
  await redis.expire(`login_failures:${userId}`, 3600);
}
```

**Validation:** Design review and security architecture assessment

---

### 5. Broken Authentication

**Risk:** Attackers compromise user accounts or sessions.

**kit Assessment:**
- [ ] Multi-factor authentication (MFA) supported
- [ ] Session management secure
- [ ] Passwords meet complexity requirements
- [ ] Default credentials removed
- [ ] Session timeout configured
- [ ] Secure cookie flags set (HttpOnly, Secure, SameSite)

**Mitigation:**
```javascript
// Secure session configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true, // HTTPS only
    httpOnly: true, // No JavaScript access
    sameSite: 'strict', // CSRF protection
    maxAge: 30 * 60 * 1000, // 30 minutes
  },
}));

// MFA support
async function enableMFA(userId) {
  const secret = speakeasy.generateSecret({
    name: `kit (${userEmail})`,
  });
  
  // Store secret securely
  await User.update(userId, {
    mfaSecret: encrypt(secret.base32),
    mfaEnabled: true,
  });
  
  return secret.qr_code_url;
}

// Verify MFA
async function verifyMFA(userId, token) {
  const secret = decrypt(user.mfaSecret);
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 2, // Allow 30 seconds of drift
  });
}
```

**Validation:** Authentication penetration testing

---

### 6. Security Misconfiguration

**Risk:** Default configurations, unnecessary services, or outdated software.

**kit Assessment:**
- [ ] Default credentials changed
- [ ] Unnecessary services disabled
- [ ] Security headers configured
- [ ] Error messages don't leak sensitive info
- [ ] No debug mode in production
- [ ] Framework/dependencies updated
- [ ] Unnecessary HTTP methods disabled
- [ ] CORS properly configured

**Mitigation:**
```javascript
// Security headers
const helmet = require('helmet');
app.use(helmet());

// Custom CSP for XSS protection
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
  },
}));

// CORS configuration
const cors = require('cors');
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS.split(','),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Disable unnecessary HTTP methods
app.disable('x-powered-by');

// Environment-based configuration
if (process.env.NODE_ENV === 'production') {
  // Disable detailed error messages
  app.use((err, req, res, next) => {
    console.error('Internal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });
}
```

**Validation:** Configuration audit and security scanner

---

### 7. Identification & Authentication Failures

**Risk:** User identification is compromised or bypassed.

**kit Assessment:**
- [ ] JWT signature validation mandatory
- [ ] Token expiration enforced
- [ ] No token leakage in logs
- [ ] Token revocation implemented
- [ ] Session fixation prevention
- [ ] Biometric authentication options available

**Mitigation:**
```javascript
// JWT validation
const jwt = require('jsonwebtoken');

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'], // Specify algorithm
      issuer: 'kit',
      audience: 'kit-users',
      maxAge: '24h',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new Error('Token expired');
    }
    throw new Error('Invalid token');
  }
}

// Token revocation (blacklist)
const tokenBlacklist = new Set();

function revokeToken(token) {
  const decoded = jwt.decode(token);
  tokenBlacklist.add(decoded.jti);
  
  // Expire from memory after token lifetime
  setTimeout(() => {
    tokenBlacklist.delete(decoded.jti);
  }, 24 * 60 * 60 * 1000);
}

async function isTokenRevoked(jti) {
  return tokenBlacklist.has(jti);
}
```

**Validation:** Authentication flow testing and session management audit

---

### 8. Software & Data Integrity Failures

**Risk:** Insecure updates or CI/CD pipeline compromises.

**kit Assessment:**
- [ ] Code signed and verified
- [ ] Commit signing required
- [ ] Dependency verification enabled
- [ ] CI/CD pipeline secured
- [ ] Container images signed
- [ ] Supply chain security implemented
- [ ] Build artifacts integrity verified

**Mitigation:**
```bash
# Git commit signing
git config user.signingkey <GPG_KEY_ID>
git commit -S -m "Commit message"
git verify-commit <commit>

# Container image signing
docker trust key load key.key
docker trust signer add --key key.pub myname myimage

# Dependency lock file
npm ci --frozen-lockfile # Don't update dependencies
```

**Validation:** Supply chain security audit

---

### 9. Logging & Monitoring Failures

**Risk:** Security events not detected or investigated.

**kit Assessment:**
- [ ] Security events logged
- [ ] Logs not accessible to unauthorized users
- [ ] Logs immutable (write-once)
- [ ] Monitoring alerts configured
- [ ] Incident response procedures documented
- [ ] No sensitive data logged
- [ ] Log retention policy enforced

**Mitigation:**
```javascript
// Security event logging
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'kit' },
  transports: [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/security.log',
    }),
  ],
});

// Log security events
function logSecurityEvent(event, details) {
  logger.warn('SECURITY_EVENT', {
    event,
    timestamp: new Date().toISOString(),
    userId: details.userId,
    action: details.action,
    resource: details.resource,
    result: details.result,
    // Don't log sensitive data
  });
}

// Example usage
logSecurityEvent('AUTH_FAILURE', {
  userId: '...',
  action: 'login',
  resource: 'authentication',
  result: 'failed_password',
});

logSecurityEvent('PRIVILEGE_ESCALATION_ATTEMPT', {
  userId: '...',
  action: 'modify_permissions',
  resource: 'user:123',
  result: 'denied',
});
```

**Validation:** Log review and monitoring alert testing

---

### 10. Server-Side Request Forgery (SSRF)

**Risk:** Application makes requests to unintended destinations.

**kit Assessment:**
- [ ] Request destination validation
- [ ] No access to internal metadata services
- [ ] Rate limiting on external requests
- [ ] Timeout on external requests
- [ ] Hostname/IP validation

**Mitigation:**
```javascript
// SSRF protection
const url = require('url');
const axios = require('axios');

// Whitelist of allowed domains
const ALLOWED_DOMAINS = ['api.example.com', 'cdn.example.com'];

async function makeSecureRequest(requestUrl) {
  // Validate URL
  const parsed = url.parse(requestUrl);
  
  // Check domain whitelist
  if (!ALLOWED_DOMAINS.includes(parsed.hostname)) {
    throw new Error('Domain not allowed');
  }
  
  // Prevent internal IP access
  const blockedRanges = [
    /^127\./, // localhost
    /^192\.168\./, // private
    /^10\./, // private
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // private
    /^169\.254\./, // link-local
  ];
  
  for (const range of blockedRanges) {
    if (range.test(parsed.hostname)) {
      throw new Error('Internal IP access denied');
    }
  }
  
  // Make request with timeout
  try {
    return await axios.get(requestUrl, {
      timeout: 5000, // 5 second timeout
      maxRedirects: 5,
    });
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}
```

**Validation:** SSRF testing with burp or similar

---

## Infrastructure Security

### Kubernetes Security

**Pod Security Policy:**
```yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: kit-restricted
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'projected'
    - 'secret'
    - 'downwardAPI'
    - 'persistentVolumeClaim'
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'MustRunAs'
    seLinuxOptions:
      level: "s0:c123,c456"
  fsGroup:
    rule: 'MustRunAs'
    ranges:
      - min: 1000
        max: 65535
  readOnlyRootFilesystem: false
```

**Network Policies:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kit-deny-all
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kit-allow-marketplace
spec:
  podSelector:
    matchLabels:
      app: marketplace
  policyTypes:
    - Ingress
  ingress:
    - from:
      - podSelector:
          matchLabels:
            app: nginx-ingress
      ports:
      - protocol: TCP
        port: 3001
```

### AWS Security

**Security Groups:**
```
CLI Service:
  Inbound:  443/tcp from 0.0.0.0/0 (HTTPS only)
  Outbound: 443/tcp to 0.0.0.0/0 (HTTPS only)

Marketplace:
  Inbound:  443/tcp from 0.0.0.0/0 (HTTPS only)
  Outbound: 443/tcp to 0.0.0.0/0 (HTTPS only)

Database:
  Inbound:  5432/tcp from cluster-sg only
  Outbound: None
```

---

## Application Security

### Input Validation

**Strategy:** Whitelist approach - only accept known good input

```javascript
const schema = {
  username: {
    type: 'string',
    minLength: 3,
    maxLength: 30,
    pattern: '^[a-zA-Z0-9_-]+$',
  },
  email: {
    type: 'string',
    format: 'email',
  },
  age: {
    type: 'integer',
    minimum: 0,
    maximum: 150,
  },
};

// Validate using JSON Schema
const ajv = new Ajv();
const validate = ajv.compile(schema);

app.post('/api/users', (req, res) => {
  const valid = validate(req.body);
  
  if (!valid) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validate.errors,
    });
  }
  
  // Process valid input
});
```

### Output Encoding

**XSS Prevention:**
```javascript
// Encode output based on context
const entities = require('html-entities');

// HTML context
const htmlSafe = entities.encode(userInput);

// JavaScript context
const jsSafe = userInput.replace(/['"\\]/g, '\\$&');

// URL context
const urlSafe = encodeURIComponent(userInput);

// Example: Render user data safely
res.render('profile', {
  username: htmlSafe,
  bio: htmlSafe,
});
```

### Content Security Policy

```javascript
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", 'fonts.googleapis.com'],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'fonts.gstatic.com'],
    connectSrc: ["'self'"],
    frameSrc: ["'none'"],
    objectSrc: ["'none'"],
    upgradeInsecureRequests: [],
  },
}));
```

---

## Compliance & Data Protection

### GDPR Compliance

**Key Requirements:**

1. **Lawful Basis for Processing**
   - User consent required
   - Consent withdrawal supported

2. **Data Collection**
   - Only collect necessary data
   - Clear privacy notice

3. **Data Rights**
   - Right to access: Provide copy of data
   - Right to rectification: Allow correction
   - Right to erasure: Delete personal data
   - Right to portability: Export in machine-readable format

**Implementation:**
```javascript
// Consent management
async function recordConsent(userId, type) {
  await db.insert('consents', {
    userId,
    type, // 'marketing', 'analytics', etc.
    timestamp: new Date(),
    version: 1, // Consent version
  });
}

// Data access request
async function exportUserData(userId) {
  const user = await User.findById(userId);
  const issues = await Issue.find({ userId });
  const activities = await Activity.find({ userId });
  
  return {
    user,
    issues,
    activities,
    exportedAt: new Date().toISOString(),
  };
}

// Right to be forgotten
async function deleteUserData(userId) {
  // Delete personal data
  await User.delete(userId);
  await Issue.deleteMany({ userId });
  
  // Keep anonymized data for audit
  await AuditLog.create({
    action: 'user_deletion',
    userId: 'anonymized',
    timestamp: new Date(),
  });
}
```

### Privacy Policy Requirements

- [ ] What data is collected
- [ ] How data is used
- [ ] Who data is shared with
- [ ] Data retention period
- [ ] User rights (access, correction, deletion)
- [ ] Security measures
- [ ] Cookie usage
- [ ] Third-party services
- [ ] Contact information for privacy inquiries

---

## Incident Response Plan

### Incident Classification

| Severity | Response Time | Example |
|----------|---------------|---------|
| Critical | 1 hour | Data breach, service down |
| High | 4 hours | Security vulnerability, data loss risk |
| Medium | 1 day | Suspicious activity, failed intrusion attempt |
| Low | 1 week | Minor security issue, false alarm |

### Incident Response Steps

1. **Detection & Analysis**
   - Identify incident
   - Collect evidence
   - Assess severity
   - Document timeline

2. **Containment**
   - Isolate affected systems
   - Preserve logs
   - Stop ongoing attack
   - Prevent escalation

3. **Eradication**
   - Remove attacker access
   - Patch vulnerabilities
   - Change credentials
   - Update configurations

4. **Recovery**
   - Restore from backups
   - Monitor for reinfection
   - Verify system integrity
   - Return to normal operation

5. **Post-Incident**
   - Document lessons learned
   - Update policies/procedures
   - Communicate with stakeholders
   - Improve detection/prevention

### Incident Response Team

```
Incident Commander (on-call)
├── Security Lead
├── Infrastructure Lead
├── Application Lead
├── Communications Lead
└── Legal/Compliance (if needed)
```

**Contact Information:**
- [Security team contact]
- [On-call rotation]
- [Escalation procedures]

---

## Security Update Schedule

- **Critical vulnerabilities:** 24-hour patch
- **High vulnerabilities:** 7-day patch
- **Medium vulnerabilities:** 30-day patch
- **Low vulnerabilities:** Quarterly review

---

## Resources & References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [GDPR Compliance Checklist](https://gdpr-info.eu/)
- [AWS Security Best Practices](https://docs.aws.amazon.com/security/)
- [Kubernetes Security](https://kubernetes.io/docs/concepts/security/)

---

**Last Updated:** 2026-04-15  
**Version:** 1.0  
**Maintained By:** Security Team

