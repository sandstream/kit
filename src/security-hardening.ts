import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "info";
export type SecurityCheckType =
  | "dependency_scan"
  | "code_analysis"
  | "permission_check"
  | "rate_limit"
  | "encryption"
  | "auth_check";

export interface Vulnerability {
  id: string;
  cve?: string;
  type: string;
  severity: VulnerabilitySeverity;
  affectedPackage: string;
  affectedVersion: string;
  fixedVersion?: string;
  description: string;
  discoveredAt: string;
  remediationSteps: string[];
}

export interface SecurityCheckResult {
  type: SecurityCheckType;
  passed: boolean;
  message: string;
  details: Record<string, unknown>;
  severity: VulnerabilitySeverity;
  timestamp: string;
}

export interface SecurityAuditEntry {
  id: string;
  action: string;
  actor: string;
  resource: string;
  status: "success" | "failure";
  details: Record<string, unknown>;
  timestamp: string;
  ipAddress?: string;
}

export interface RateLimitConfig {
  windowMs: number; // milliseconds
  maxRequests: number;
  message?: string;
  keyGenerator?: (req: unknown) => string;
}

export interface RateLimitStatus {
  requestCount: number;
  resetTime: Date;
  remaining: number;
  retryAfter?: number;
}

export interface SecurityPolicy {
  id: string;
  name: string;
  description: string;
  rules: Array<{
    rule: string;
    enabled: boolean;
    severity: VulnerabilitySeverity;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityReport {
  pluginId: string;
  timestamp: string;
  vulnerabilities: Vulnerability[];
  checks: SecurityCheckResult[];
  score: number; // 0-100, 100 = most secure
  status: "pass" | "warning" | "fail";
}

// ─── SecurityHardeningEngine ──────────────────────────────────────────────────

export class SecurityHardeningEngine {
  private vulnerabilities: Map<string, Vulnerability> = new Map();
  private auditLog: SecurityAuditEntry[] = [];
  private rateLimiters: Map<string, Map<string, RateLimitStatus>> = new Map();
  private securityPolicies: Map<string, SecurityPolicy> = new Map();
  private checksResults: Map<string, SecurityCheckResult[]> = new Map();

  // ─── Vulnerability Management ────────────────────────────────────────────

  /**
   * Register a known vulnerability.
   */
  registerVulnerability(vuln: Vulnerability): void {
    this.vulnerabilities.set(vuln.id, vuln);
  }

  /**
   * Scan dependencies for known vulnerabilities.
   */
  scanDependencies(
    pluginId: string,
    dependencies: Array<{ name: string; version: string }>,
  ): Vulnerability[] {
    const found: Vulnerability[] = [];

    for (const dep of dependencies) {
      for (const vuln of this.vulnerabilities.values()) {
        if (
          vuln.affectedPackage === dep.name &&
          this.versionMatches(dep.version, vuln.affectedVersion)
        ) {
          found.push(vuln);
        }
      }
    }

    return found;
  }

  private versionMatches(current: string, affected: string): boolean {
    // Simple version matching: affected "*" matches all, or exact match
    if (affected === "*") return true;
    return current === affected;
  }

  /**
   * Get vulnerability by ID.
   */
  getVulnerability(vulnId: string): Vulnerability | null {
    return this.vulnerabilities.get(vulnId) || null;
  }

  /**
   * Get all vulnerabilities.
   */
  getAllVulnerabilities(): Vulnerability[] {
    return [...this.vulnerabilities.values()];
  }

  // ─── Security Checks ──────────────────────────────────────────────────────

  /**
   * Run a security check.
   */
  runSecurityCheck(
    type: SecurityCheckType,
    pluginId: string,
    data: Record<string, unknown>,
  ): SecurityCheckResult {
    let result: SecurityCheckResult;

    switch (type) {
      case "dependency_scan":
        result = this.checkDependencyScan(pluginId, data);
        break;
      case "permission_check":
        result = this.checkPermissions(pluginId, data);
        break;
      case "encryption":
        result = this.checkEncryption(pluginId, data);
        break;
      case "auth_check":
        result = this.checkAuthentication(pluginId, data);
        break;
      default:
        result = {
          type,
          passed: true,
          message: "Check skipped",
          details: {},
          severity: "info",
          timestamp: new Date().toISOString(),
        };
    }

    // Store result
    const results = this.checksResults.get(pluginId) || [];
    results.push(result);
    this.checksResults.set(pluginId, results);

    return result;
  }

  private checkDependencyScan(
    pluginId: string,
    data: Record<string, unknown>,
  ): SecurityCheckResult {
    const deps = data.dependencies as Array<{ name: string; version: string }> || [];
    const vulns = this.scanDependencies(pluginId, deps);

    return {
      type: "dependency_scan",
      passed: vulns.length === 0,
      message: vulns.length === 0 ? "No vulnerabilities found" : `${vulns.length} vulnerabilities found`,
      details: { vulnerabilities: vulns },
      severity: vulns.length > 0 ? "high" : "info",
      timestamp: new Date().toISOString(),
    };
  }

  private checkPermissions(pluginId: string, data: Record<string, unknown>): SecurityCheckResult {
    const permissions = data.permissions as string[] || [];
    const dangerous = ["root", "admin", "system"];
    const hasDangerous = permissions.some((p) => dangerous.includes(p));

    return {
      type: "permission_check",
      passed: !hasDangerous,
      message: hasDangerous ? "Dangerous permissions detected" : "Safe permission levels",
      details: { permissions, hasDangerous },
      severity: hasDangerous ? "critical" : "info",
      timestamp: new Date().toISOString(),
    };
  }

  private checkEncryption(pluginId: string, data: Record<string, unknown>): SecurityCheckResult {
    const usesEncryption = data.usesEncryption === true;
    const algorithm = data.algorithm as string || "unknown";

    return {
      type: "encryption",
      passed: usesEncryption && ["AES-256", "TLS", "HTTPS"].includes(algorithm),
      message: usesEncryption ? "Encryption enabled" : "Encryption not found",
      details: { usesEncryption, algorithm },
      severity: usesEncryption ? "info" : "medium",
      timestamp: new Date().toISOString(),
    };
  }

  private checkAuthentication(pluginId: string, data: Record<string, unknown>): SecurityCheckResult {
    const hasAuth = data.hasAuthentication === true;
    const authMethod = data.authMethod as string || "none";

    return {
      type: "auth_check",
      passed: hasAuth && ["oauth", "jwt", "apikey"].includes(authMethod),
      message: hasAuth ? "Authentication configured" : "No authentication found",
      details: { hasAuth, authMethod },
      severity: hasAuth ? "info" : "high",
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Audit Logging ────────────────────────────────────────────────────────

  /**
   * Log a security audit event.
   */
  logAuditEvent(
    action: string,
    actor: string,
    resource: string,
    status: "success" | "failure",
    details: Record<string, unknown> = {},
    ipAddress?: string,
  ): SecurityAuditEntry {
    const id = IdGenerators.audit();
    const entry: SecurityAuditEntry = {
      id,
      action,
      actor,
      resource,
      status,
      details,
      timestamp: new Date().toISOString(),
      ipAddress,
    };

    this.auditLog.push(entry);
    return entry;
  }

  /**
   * Get audit log entries.
   */
  getAuditLog(limit = 100, offset = 0): SecurityAuditEntry[] {
    return this.auditLog.slice(offset, offset + limit);
  }

  /**
   * Get audit log entries for actor.
   */
  getAuditLogForActor(actor: string): SecurityAuditEntry[] {
    return this.auditLog.filter((e) => e.actor === actor);
  }

  /**
   * Get failed audit events.
   */
  getFailedAuditEvents(): SecurityAuditEntry[] {
    return this.auditLog.filter((e) => e.status === "failure");
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────────

  /**
   * Configure rate limiting for an endpoint.
   */
  configureRateLimit(endpoint: string, config: RateLimitConfig): void {
    const limiters = this.rateLimiters.get(endpoint) || new Map();
    // Store config (simplified - in real implementation would use the config)
    this.rateLimiters.set(endpoint, limiters);
  }

  /**
   * Check if a request is rate limited.
   */
  checkRateLimit(endpoint: string, key: string): RateLimitStatus {
    const limiters = this.rateLimiters.get(endpoint) || new Map();
    const status = limiters.get(key) || {
      requestCount: 0,
      resetTime: new Date(Date.now() + 60000), // 1 minute window
      remaining: 100,
    };

    status.requestCount++;
    status.remaining = Math.max(0, 100 - status.requestCount);

    limiters.set(key, status);
    this.rateLimiters.set(endpoint, limiters);

    return status;
  }

  /**
   * Reset rate limit for a key.
   */
  resetRateLimit(endpoint: string, key: string): void {
    const limiters = this.rateLimiters.get(endpoint);
    limiters?.delete(key);
  }

  // ─── Security Policies ────────────────────────────────────────────────────

  /**
   * Create a security policy.
   */
  createPolicy(name: string, description: string, rules: string[]): SecurityPolicy {
    const id = IdGenerators.policy();
    const policy: SecurityPolicy = {
      id,
      name,
      description,
      rules: rules.map((rule) => ({
        rule,
        enabled: true,
        severity: "high",
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.securityPolicies.set(id, policy);
    return policy;
  }

  /**
   * Get security policy.
   */
  getPolicy(policyId: string): SecurityPolicy | null {
    return this.securityPolicies.get(policyId) || null;
  }

  /**
   * Get all policies.
   */
  getAllPolicies(): SecurityPolicy[] {
    return [...this.securityPolicies.values()];
  }

  // ─── Security Report Generation ───────────────────────────────────────────

  /**
   * Generate security report for a plugin.
   */
  generateSecurityReport(pluginId: string): SecurityReport {
    const vulns = this.scanDependencies(pluginId, []);
    const checks = this.checksResults.get(pluginId) || [];

    // Calculate score: 100 - (vulnerabilities * 10 + failed_checks * 5)
    let score = 100;
    score -= vulns.length * 10;
    score -= checks.filter((c) => !c.passed).length * 5;
    score = Math.max(0, Math.min(100, score));

    const status = score >= 80 ? "pass" : score >= 60 ? "warning" : "fail";

    return {
      pluginId,
      timestamp: new Date().toISOString(),
      vulnerabilities: vulns,
      checks,
      score,
      status,
    };
  }

  /**
   * Get security score for plugin.
   */
  getSecurityScore(pluginId: string): number {
    const report = this.generateSecurityReport(pluginId);
    return report.score;
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getVulnerabilitiesCache(): Map<string, Vulnerability> {
    return this.vulnerabilities;
  }

  getAuditLogCache(): SecurityAuditEntry[] {
    return this.auditLog;
  }

  getPoliciesCache(): Map<string, SecurityPolicy> {
    return this.securityPolicies;
  }
}
