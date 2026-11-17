import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_EXCEPTIONS_FILE,
  auditDecision,
  parseAuditExceptions,
  unexcusedFindings,
} from "./audit-exceptions.js";

const NOW = new Date("2026-11-17T12:00:00Z");
const ADVISORY = "GHSA-fc5q-39xc-vjpf";
const url = (id: string): string => `https://github.com/advisories/${id}`;

/** The shape `npm audit --json` gives: one root advisory, and packages that inherit it by name. */
function chain(rootUrl = url(ADVISORY)): unknown {
  return {
    vulnerabilities: {
      picomatch: {
        name: "picomatch",
        severity: "high",
        via: [{ name: "picomatch", severity: "high", url: rootUrl }],
      },
      fdir: { name: "fdir", severity: "high", via: ["picomatch"] },
      tinyglobby: { name: "tinyglobby", severity: "high", via: ["fdir", "picomatch"] },
    },
  };
}

const exception = (over: Record<string, unknown> = {}): unknown => ({
  advisory: ADVISORY,
  reason: "dev-only glob matcher, no patched version exists",
  expires: "2026-12-17",
  ...over,
});

describe("parseAuditExceptions", () => {
  it("accepts a well-formed list", () => {
    const r = parseAuditExceptions([exception()]);
    assert.deepEqual(r.problems, []);
    assert.equal(r.exceptions.length, 1);
    assert.equal(r.exceptions[0].advisory, ADVISORY);
  });

  it("rejects an entry without a reason, with a bad id or with a bad date", () => {
    for (const bad of [
      exception({ reason: "" }),
      exception({ reason: undefined }),
      exception({ advisory: "picomatch" }),
      exception({ expires: "soon" }),
      exception({ expires: undefined }),
    ]) {
      const r = parseAuditExceptions([bad], NOW);
      assert.equal(r.exceptions.length, 0, JSON.stringify(bad));
      assert.equal(r.problems.length, 1, JSON.stringify(bad));
    }
  });

  it("refuses an expiry more than 90 days ahead, so no exception is permanent", () => {
    const r = parseAuditExceptions([exception({ expires: "2027-06-01" })], NOW);
    assert.equal(r.exceptions.length, 0);
    assert.match(r.problems[0], /90 days/);
  });

  it("refuses a file that is not a list", () => {
    const r = parseAuditExceptions({ advisory: ADVISORY }, NOW);
    assert.equal(r.exceptions.length, 0);
    assert.equal(r.problems.length, 1);
  });
});

describe("unexcusedFindings", () => {
  it("excuses the root advisory and every package that only inherits it", () => {
    const { exceptions } = parseAuditExceptions([exception()], NOW);
    const r = unexcusedFindings(chain(), exceptions, NOW);
    assert.deepEqual(r.unexcused, []);
    assert.deepEqual(r.excused.sort(), ["fdir", "picomatch", "tinyglobby"]);
  });

  it("reports everything when there is no exception", () => {
    const r = unexcusedFindings(chain(), [], NOW);
    assert.deepEqual(r.unexcused.sort(), ["fdir", "picomatch", "tinyglobby"]);
  });

  it("does not excuse a different advisory on the same package", () => {
    const { exceptions } = parseAuditExceptions([exception()], NOW);
    const r = unexcusedFindings(chain(url("GHSA-aaaa-bbbb-cccc")), exceptions, NOW);
    assert.deepEqual(r.unexcused.sort(), ["fdir", "picomatch", "tinyglobby"]);
  });

  it("stops excusing the day after the exception expires and names it as expired", () => {
    const { exceptions } = parseAuditExceptions([exception()], NOW);
    const later = new Date("2026-12-18T00:00:00Z");
    const r = unexcusedFindings(chain(), exceptions, later);
    assert.equal(r.unexcused.length, 3);
    assert.deepEqual(r.expired, [ADVISORY]);
  });

  it("keeps a package that has a second, unexcepted advisory", () => {
    const { exceptions } = parseAuditExceptions([exception()], NOW);
    const audit = chain() as { vulnerabilities: Record<string, { via: unknown[] }> };
    audit.vulnerabilities.fdir.via.push({
      name: "fdir",
      severity: "high",
      url: url("GHSA-zzzz-yyyy-xxxx"),
    });
    const r = unexcusedFindings(audit, exceptions, NOW);
    assert.deepEqual(r.unexcused, ["fdir", "tinyglobby"]);
    assert.deepEqual(r.excused, ["picomatch"]);
  });

  it("ignores findings below high, as npm audit --audit-level=high does", () => {
    const audit = {
      vulnerabilities: {
        left: {
          name: "left",
          severity: "moderate",
          via: [{ name: "left", severity: "moderate", url: url("GHSA-aaaa-bbbb-cccc") }],
        },
      },
    };
    const r = unexcusedFindings(audit, [], NOW);
    assert.deepEqual(r.unexcused, []);
    assert.deepEqual(r.excused, []);
  });

  it("terminates on a dependency cycle", () => {
    const audit = {
      vulnerabilities: {
        a: { name: "a", severity: "high", via: ["b"] },
        b: { name: "b", severity: "high", via: ["a"] },
      },
    };
    const r = unexcusedFindings(audit, [], NOW);
    assert.deepEqual(r.unexcused.sort(), ["a", "b"]);
  });

  it("treats a report without a vulnerabilities map as having no findings", () => {
    assert.deepEqual(unexcusedFindings({}, [], NOW), { unexcused: [], excused: [], expired: [] });
  });
});

describe("auditDecision", () => {
  const withFile = async (
    body: string | null,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-exc-"));
    try {
      if (body !== null) writeFileSync(join(dir, AUDIT_EXCEPTIONS_FILE), body);
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const report = (
    high: number,
    vulns: unknown = (chain() as { vulnerabilities: unknown }).vulnerabilities,
  ) => ({
    metadata: { vulnerabilities: { high, critical: 0 } },
    vulnerabilities: vulns,
  });
  const good = JSON.stringify([exception()]);

  it("is not covered when the repo has no exception file", async () => {
    await withFile(null, async (dir) => {
      assert.deepEqual(await auditDecision(dir, report(3), NOW), { covered: false, note: "" });
    });
  });

  it("is covered, and says which advisory until when, when the file covers every finding", async () => {
    await withFile(good, async (dir) => {
      const r = await auditDecision(dir, report(3), NOW);
      assert.equal(r.covered, true);
      assert.match(r.note, /GHSA-fc5q-39xc-vjpf/);
      assert.match(r.note, /2026-12-17/);
    });
  });

  it("is not covered when the report counts more findings than its package list explains", async () => {
    await withFile(good, async (dir) => {
      assert.equal((await auditDecision(dir, report(4), NOW)).covered, false);
      assert.equal(
        (await auditDecision(dir, { metadata: { vulnerabilities: { high: 3 } } }, NOW)).covered,
        false,
      );
    });
  });

  it("is not covered, and says so, once the exception has expired", async () => {
    await withFile(good, async (dir) => {
      const r = await auditDecision(dir, report(3), new Date("2026-12-18T00:00:00Z"));
      assert.equal(r.covered, false);
      assert.match(r.note, /expired/);
    });
  });

  it("is not covered, and names the problem, for a malformed file", async () => {
    await withFile("{not json", async (dir) => {
      const r = await auditDecision(dir, report(3), NOW);
      assert.equal(r.covered, false);
      assert.match(r.note, /audit-exceptions\.json/);
    });
    await withFile(JSON.stringify([exception({ reason: "" })]), async (dir) => {
      const r = await auditDecision(dir, report(3), NOW);
      assert.equal(r.covered, false);
      assert.match(r.note, /reason is required/);
    });
  });
});
