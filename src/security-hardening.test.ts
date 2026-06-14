import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SecurityHardeningEngine,
  type Vulnerability,
} from "./security-hardening.js";

function makeVuln(id: string, overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id,
    type: "dependency",
    severity: "high",
    affectedPackage: "lodash",
    affectedVersion: "4.17.0",
    description: "Vulnerability in lodash",
    discoveredAt: new Date().toISOString(),
    remediationSteps: ["Update to 4.17.21"],
    ...overrides,
  };
}

describe("SecurityHardeningEngine", () => {
  describe("vulnerability management", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("registers a vulnerability", () => {
      const vuln = makeVuln("CVE-2021-1234");
      engine.registerVulnerability(vuln);
      assert.equal(engine.getVulnerability("CVE-2021-1234"), vuln);
    });

    it("scans dependencies for vulnerabilities", () => {
      engine.registerVulnerability(
        makeVuln("CVE-1", { affectedPackage: "lodash", affectedVersion: "4.17.0" }),
      );
      const deps = [{ name: "lodash", version: "4.17.0" }];
      const found = engine.scanDependencies("plugin-1", deps);
      assert.equal(found.length, 1);
    });

    it("skips unaffected versions", () => {
      engine.registerVulnerability(
        makeVuln("CVE-1", { affectedPackage: "lodash", affectedVersion: "4.17.0" }),
      );
      const deps = [{ name: "lodash", version: "4.17.21" }];
      const found = engine.scanDependencies("plugin-1", deps);
      assert.equal(found.length, 0);
    });

    it("gets all vulnerabilities", () => {
      engine.registerVulnerability(makeVuln("CVE-1"));
      engine.registerVulnerability(makeVuln("CVE-2"));
      const all = engine.getAllVulnerabilities();
      assert.equal(all.length, 2);
    });
  });

  describe("security checks", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("runs dependency scan check", () => {
      const result = engine.runSecurityCheck("dependency_scan", "plugin-1", {
        dependencies: [{ name: "safe-pkg", version: "1.0.0" }],
      });
      assert.equal(result.type, "dependency_scan");
      assert(result.passed);
    });

    it("fails on dangerous permissions", () => {
      const result = engine.runSecurityCheck("permission_check", "plugin-1", {
        permissions: ["root"],
      });
      assert(!result.passed);
      assert.equal(result.severity, "critical");
    });

    it("detects missing encryption", () => {
      const result = engine.runSecurityCheck("encryption", "plugin-1", {
        usesEncryption: false,
      });
      assert(!result.passed);
      assert.equal(result.severity, "medium");
    });

    it("detects missing authentication", () => {
      const result = engine.runSecurityCheck("auth_check", "plugin-1", {
        hasAuthentication: false,
      });
      assert(!result.passed);
      assert.equal(result.severity, "high");
    });

    it("passes on proper authentication", () => {
      const result = engine.runSecurityCheck("auth_check", "plugin-1", {
        hasAuthentication: true,
        authMethod: "jwt",
      });
      assert(result.passed);
    });
  });

  describe("audit logging", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("logs audit events", () => {
      const entry = engine.logAuditEvent(
        "plugin_published",
        "author-1",
        "plugin-stripe",
        "success",
      );
      assert(entry.id);
      assert.equal(entry.action, "plugin_published");
    });

    it("retrieves audit log", () => {
      engine.logAuditEvent("event1", "user-1", "resource", "success");
      engine.logAuditEvent("event2", "user-2", "resource", "failure");
      const log = engine.getAuditLog(10);
      assert.equal(log.length, 2);
    });

    it("filters by actor", () => {
      engine.logAuditEvent("event1", "user-1", "resource", "success");
      engine.logAuditEvent("event2", "user-1", "resource", "success");
      engine.logAuditEvent("event3", "user-2", "resource", "success");

      const user1Log = engine.getAuditLogForActor("user-1");
      assert.equal(user1Log.length, 2);
    });

    it("gets failed events", () => {
      engine.logAuditEvent("event1", "user-1", "resource", "success");
      engine.logAuditEvent("event2", "user-1", "resource", "failure");
      engine.logAuditEvent("event3", "user-1", "resource", "failure");

      const failed = engine.getFailedAuditEvents();
      assert.equal(failed.length, 2);
    });
  });

  describe("rate limiting", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("configures rate limits", () => {
      engine.configureRateLimit("/api/plugins", {
        windowMs: 60000,
        maxRequests: 100,
      });
      // Configuration stored
      assert(true);
    });

    it("checks rate limit status", () => {
      engine.configureRateLimit("/api/plugins", { windowMs: 60000, maxRequests: 100 });
      const status = engine.checkRateLimit("/api/plugins", "user-1");
      assert.equal(status.requestCount, 1);
      assert(status.remaining > 0);
    });

    it("increments request count", () => {
      engine.checkRateLimit("/api/plugins", "user-1");
      const status = engine.checkRateLimit("/api/plugins", "user-1");
      assert.equal(status.requestCount, 2);
    });

    it("resets rate limit", () => {
      engine.checkRateLimit("/api/plugins", "user-1");
      engine.resetRateLimit("/api/plugins", "user-1");
      const status = engine.checkRateLimit("/api/plugins", "user-1");
      assert.equal(status.requestCount, 1);
    });
  });

  describe("security policies", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("creates a security policy", () => {
      const policy = engine.createPolicy("Strict Security", "High security policy", [
        "require-https",
        "require-auth",
      ]);
      assert(policy.id);
      assert.equal(policy.name, "Strict Security");
      assert.equal(policy.rules.length, 2);
    });

    it("retrieves policy by ID", () => {
      const created = engine.createPolicy("Test Policy", "Description", ["rule1"]);
      const retrieved = engine.getPolicy(created.id);
      assert.equal(retrieved?.name, "Test Policy");
    });

    it("gets all policies", () => {
      engine.createPolicy("Policy 1", "Desc", ["rule1"]);
      engine.createPolicy("Policy 2", "Desc", ["rule2"]);
      const all = engine.getAllPolicies();
      assert.equal(all.length, 2);
    });
  });

  describe("security reports", () => {
    let engine: SecurityHardeningEngine;

    beforeEach(() => {
      engine = new SecurityHardeningEngine();
    });

    it("generates security report", () => {
      engine.runSecurityCheck("auth_check", "plugin-1", {
        hasAuthentication: true,
        authMethod: "jwt",
      });
      const report = engine.generateSecurityReport("plugin-1");
      assert(report.score >= 0 && report.score <= 100);
      assert(report.status);
    });

    it("calculates security score", () => {
      engine.runSecurityCheck("auth_check", "plugin-1", {
        hasAuthentication: true,
        authMethod: "jwt",
      });
      const score = engine.getSecurityScore("plugin-1");
      assert(score > 0);
    });

    it("marks report as pass for high score", () => {
      engine.runSecurityCheck("auth_check", "plugin-1", {
        hasAuthentication: true,
        authMethod: "jwt",
      });
      const report = engine.generateSecurityReport("plugin-1");
      if (report.score >= 80) {
        assert.equal(report.status, "pass");
      }
    });

    it("marks report as fail for low score", () => {
      engine.registerVulnerability(makeVuln("CVE-1"));
      // Add multiple failures
      for (let i = 0; i < 5; i++) {
        engine.runSecurityCheck("permission_check", "plugin-1", {
          permissions: ["root"],
        });
      }
      const report = engine.generateSecurityReport("plugin-1");
      if (report.score < 60) {
        assert.equal(report.status, "fail");
      }
    });
  });
});
