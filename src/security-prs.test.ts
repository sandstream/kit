import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bumpTarget,
  ciState,
  rankSecurityPrs,
  securityPrsLine,
  type OpenPr,
  type SecurityAlert,
} from "./security-prs.js";

const pr = (number: number, title: string, over: Partial<OpenPr> = {}): OpenPr => ({
  number,
  title,
  updatedAt: "2026-11-01T00:00:00Z",
  author: { login: "dependabot", isBot: true },
  checks: [{ state: "SUCCESS" }],
  ...over,
});

describe("bumpTarget", () => {
  it("reads package and target version from a Dependabot title", () => {
    assert.deepEqual(bumpTarget("build(deps): bump vite from 6.4.1 to 6.4.5"), {
      name: "vite",
      to: "6.4.5",
    });
    assert.deepEqual(bumpTarget("Bump @scope/pkg from 1.0.0 to 1.0.1 in /web"), {
      name: "@scope/pkg",
      to: "1.0.1",
    });
  });
  it("returns null for a title that is not a bump", () => {
    assert.equal(bumpTarget("feat: add a thing"), null);
  });
  it("refuses a name or version that holds anything but package characters", () => {
    assert.equal(bumpTarget("bump vite\u001b[2J from 1.0.0 to 2.0.0"), null);
    assert.equal(bumpTarget("bump vite from 1.0.0 to 2.0.0\u001b]0;x\u0007"), null);
  });
});

describe("ciState", () => {
  it("is failing when any check failed, pending when one is unfinished, else passing", () => {
    assert.equal(ciState([{ state: "SUCCESS" }, { state: "FAILURE" }]), "failing");
    assert.equal(ciState([{ state: "SUCCESS" }, { state: "PENDING" }]), "pending");
    assert.equal(ciState([{ state: "SUCCESS" }, { state: "SKIPPED" }]), "passing");
  });
  it("is none without checks, never passing", () => {
    assert.equal(ciState([]), "none");
  });
});

describe("rankSecurityPrs", () => {
  const alerts: SecurityAlert[] = [
    { name: "vite", severity: "critical", patched: "6.4.5" },
    { name: "lodash", severity: "low", patched: "4.17.22" },
    { name: "axios", severity: "high", patched: "1.9.0" },
  ];

  it("keeps only PRs that fix an open advisory and orders them by severity", () => {
    const ranked = rankSecurityPrs(
      [
        pr(1, "bump lodash from 4.17.1 to 4.17.22"),
        pr(2, "bump left-pad from 1.0.0 to 1.0.1"),
        pr(3, "bump vite from 6.4.1 to 6.4.5"),
        pr(4, "bump axios from 1.0.0 to 1.9.0"),
      ],
      alerts,
    );
    assert.deepEqual(
      ranked.map((r) => [r.number, r.severity]),
      [
        [3, "critical"],
        [4, "high"],
        [1, "low"],
      ],
    );
  });

  it("a critical PR outranks a stale green one of lower severity", () => {
    const ranked = rankSecurityPrs(
      [
        pr(1, "bump axios from 1.0.0 to 1.9.0", { updatedAt: "2026-01-01T00:00:00Z" }),
        pr(2, "bump vite from 6.4.1 to 6.4.5", { checks: [{ state: "FAILURE" }] }),
      ],
      alerts,
    );
    assert.equal(ranked[0]?.number, 2);
  });

  it("ties on severity go to the older PR", () => {
    const ranked = rankSecurityPrs(
      [
        pr(1, "bump vite from 6.4.1 to 6.4.5", { updatedAt: "2026-11-02T00:00:00Z" }),
        pr(2, "bump vite from 6.4.2 to 6.4.5", { updatedAt: "2026-10-01T00:00:00Z" }),
      ],
      alerts,
    );
    assert.deepEqual(
      ranked.map((r) => r.number),
      [2, 1],
    );
  });

  it("ignores a PR that is not from Dependabot, however its title reads", () => {
    const ranked = rankSecurityPrs(
      [
        pr(1, "bump vite from 6.4.1 to 6.4.5", { author: { login: "someone", isBot: false } }),
        pr(2, "bump vite from 6.4.1 to 6.4.5", { author: { login: "dependabot", isBot: false } }),
        pr(3, "bump vite from 6.4.1 to 6.4.5", { author: undefined }),
      ],
      alerts,
    );
    assert.deepEqual(ranked, []);
  });

  it("builds the shown title from the package and version, not from the PR text", () => {
    const [top] = rankSecurityPrs([pr(1, "chore: bump vite from 6.4.1 to 6.4.5 now")], alerts);
    assert.equal(top?.title, "bump vite to 6.4.5");
  });

  it("does not count a bump that stays below the patched version", () => {
    const ranked = rankSecurityPrs([pr(1, "bump vite from 6.4.1 to 6.4.4")], alerts);
    assert.deepEqual(ranked, []);
  });

  it("matches a bump of the fixed version or newer", () => {
    const ranked = rankSecurityPrs([pr(1, "bump vite from 6.4.1 to 7.0.0")], alerts);
    assert.equal(ranked.length, 1);
  });
});

describe("securityPrsLine", () => {
  it("is null when nothing is open", () => {
    assert.equal(securityPrsLine([]), null);
  });
  it("names the count, the top severity and the top PR with its CI state", () => {
    const ranked = rankSecurityPrs(
      [pr(3, "bump vite from 6.4.1 to 6.4.5", { checks: [{ state: "FAILURE" }] })],
      [{ name: "vite", severity: "critical", patched: "6.4.5" }],
    );
    assert.equal(securityPrsLine(ranked), "sec-prs:1 critical #3 ci:failing");
  });
});
