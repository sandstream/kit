/** The check-skills gate's pure core: which staged skills lack a fresh deep triage of their content. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deepSkillTriageFailures, parseStagedSkillNames } from "./skill-triage-gate.js";

// A triage-log entry shaped like the ones recordTriageRun writes.
const logEntry = (o: {
  target: string;
  deep?: boolean;
  type?: string;
  timestamp?: string;
  contentDigest?: string | null;
}) => ({
  timestamp: o.timestamp ?? "2026-07-10T12:00:00Z",
  type: o.type ?? "skill",
  target: o.target,
  sandbox: false,
  deep: o.deep,
  granter: "tester",
  skillScan: {
    version: 1 as const,
    source: "skillspector-static" as const,
    reportDigest: "sha256:" + "0".repeat(64),
    runs: [
      {
        scannerVersion: "0.0.1-test",
        coveragePercent: 100 as const,
        fullyInspectedFiles: 1,
        scopeExclusionCount: 0 as const,
      },
    ],
  },
  ...(o.contentDigest === null ? {} : { contentDigest: o.contentDigest ?? STAGED }),
});
// The digest of the staged content of every skill in these tests.
const STAGED = "sha256:staged";
const DIGESTS = new Map(["searxng", "triage", "a", "b", "new"].map((n) => [n, STAGED]));

describe("check-skills gate — parseStagedSkillNames", () => {
  it("extracts unique skill names from staged files inside .claude/skills/<name>/", () => {
    const names = parseStagedSkillNames([
      ".claude/skills/searxng/SKILL.md",
      ".claude/skills/searxng/scripts/run.sh",
      ".claude/skills/triage/SKILL.md",
      "src/unrelated.ts",
      ".claude/skills/README.md", // a file directly in skills/, not inside a skill dir
      "",
    ]);
    assert.deepEqual(names.sort(), ["searxng", "triage"]);
  });

  it("returns [] when no skill files are staged", () => {
    assert.deepEqual(parseStagedSkillNames(["package.json", "src/x.ts"]), []);
  });
});

function failedNames(...args: Parameters<typeof deepSkillTriageFailures>): string[] {
  return [...deepSkillTriageFailures(...args).keys()];
}

describe("check-skills receipt status", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");

  it("explains expired, legacy, malformed, and missing evidence separately", () => {
    const expired = logEntry({ target: "a", deep: true, timestamp: "2026-06-01T00:00:00Z" });
    const legacy = { ...logEntry({ target: "b", deep: true }), skillScan: undefined };
    const malformed = logEntry({ target: "new", deep: true, timestamp: "not-a-date" });
    const otherType = logEntry({ target: "triage", deep: true, type: "npm" });
    const reasons = deepSkillTriageFailures(
      ["a", "b", "new", "triage"],
      [expired, legacy, malformed, otherType],
      now,
      DIGESTS,
    );
    assert.deepEqual(
      [...reasons],
      [
        ["a", "expired"],
        ["b", "unsupported receipt format"],
        ["new", "malformed receipt"],
        ["triage", "missing receipt"],
      ],
    );
  });
});

describe("check-skills gate decisions", () => {
  const NOW = Date.parse("2026-07-11T12:00:00Z");

  it("a fresh deep entry satisfies the gate (path-form target matches the skill name)", () => {
    const entries = [
      logEntry({ target: ".claude/skills/searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), []);
  });

  it("a shallow-only entry does NOT satisfy the deep gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: false, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("a stale deep entry (older than the max age) does NOT satisfy the gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-06-01T00:00:00Z" }),
    ];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("rejects a future-dated report without hiding valid evidence", () => {
    const future = logEntry({ target: "searxng", deep: true, timestamp: "2026-07-12T00:00:00Z" });
    const current = logEntry({ target: "searxng", deep: true, timestamp: "2026-07-11T00:00:00Z" });
    assert.deepEqual(failedNames(["searxng"], [future], NOW, DIGESTS), ["searxng"]);
    assert.deepEqual(failedNames(["searxng"], [future, current], NOW, DIGESTS), []);
  });

  it("no triage log at all ⇒ every staged skill is missing", () => {
    assert.deepEqual(failedNames(["a", "b"], [], NOW, DIGESTS).sort(), ["a", "b"]);
  });

  it("a deep entry for other content under the same name does NOT satisfy the gate", () => {
    // An earlier version of the skill, or an unrelated directory that is also called searxng.
    const entries = [
      logEntry({ target: "/tmp/elsewhere/searxng", deep: true, contentDigest: "sha256:other" }),
    ];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("an entry written before kit recorded digests does NOT satisfy the gate", () => {
    const entries = [logEntry({ target: "searxng", deep: true, contentDigest: null })];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("a staged skill whose index could not be read (no digest) is missing", () => {
    const entries = [logEntry({ target: "searxng", deep: true })];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, new Map()), ["searxng"]);
  });

  it("a Windows path target matches its skill name", () => {
    const entries = [logEntry({ target: ".claude\\skills\\searxng", deep: true })];
    assert.deepEqual(failedNames(["searxng"], entries, NOW, DIGESTS), []);
  });

  it("mixes satisfied and missing skills correctly", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }), // fresh deep
      logEntry({ target: "triage", deep: false, timestamp: "2026-07-10T00:00:00Z" }), // shallow
    ];
    assert.deepEqual(failedNames(["searxng", "triage", "new"], entries, NOW, DIGESTS).sort(), [
      "new",
      "triage",
    ]);
  });
});
