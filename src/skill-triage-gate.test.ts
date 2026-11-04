/** The check-skills gate's pure core: which staged skills lack a fresh deep triage of their content. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  latestDeepSkillTriage,
  missingDeepSkillTriage,
  parseStagedSkillNames,
} from "./skill-triage-gate.js";

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

describe("check-skills gate — latestDeepSkillTriage", () => {
  const NOW = Date.parse("2026-07-11T12:00:00Z");

  it("counts only type:skill + deep:true, keeps the most recent, normalizes path targets", () => {
    const latest = latestDeepSkillTriage([
      logEntry({ target: ".claude/skills/searxng", deep: true, timestamp: "2026-07-05T00:00:00Z" }),
      logEntry({ target: "searxng", deep: true, timestamp: "2026-07-09T00:00:00Z" }), // newer
      logEntry({ target: "searxng", deep: false, timestamp: "2026-07-10T00:00:00Z" }), // shallow — ignored
      logEntry({ target: "express", deep: true, type: "npm" }), // not a skill — ignored
    ]);
    assert.equal(latest.size, 1);
    assert.equal(latest.get("searxng"), Date.parse("2026-07-09T00:00:00Z"));
  });

  it("drops entries with a forged/unparseable timestamp (never counts as fresh)", () => {
    const latest = latestDeepSkillTriage([
      logEntry({ target: "searxng", deep: true, timestamp: "not-a-date" }),
    ]);
    assert.equal(latest.has("searxng"), false);
    // and such a skill therefore reads as missing
    assert.deepEqual(
      missingDeepSkillTriage(
        ["searxng"],
        [logEntry({ target: "searxng", deep: true, timestamp: "not-a-date" })],
        NOW,
        DIGESTS,
      ),
      ["searxng"],
    );
  });
});

describe("check-skills gate — missingDeepSkillTriage (fail-closed)", () => {
  const NOW = Date.parse("2026-07-11T12:00:00Z");

  it("a fresh deep entry satisfies the gate (path-form target matches the skill name)", () => {
    const entries = [
      logEntry({ target: ".claude/skills/searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), []);
  });

  it("a shallow-only entry does NOT satisfy the deep gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: false, timestamp: "2026-07-10T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("a stale deep entry (older than the max age) does NOT satisfy the gate", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-06-01T00:00:00Z" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("no triage log at all ⇒ every staged skill is missing", () => {
    assert.deepEqual(missingDeepSkillTriage(["a", "b"], [], NOW, DIGESTS).sort(), ["a", "b"]);
  });

  it("a deep entry for other content under the same name does NOT satisfy the gate", () => {
    // An earlier version of the skill, or an unrelated directory that is also called searxng.
    const entries = [
      logEntry({ target: "/tmp/elsewhere/searxng", deep: true, contentDigest: "sha256:other" }),
    ];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("an entry written before kit recorded digests does NOT satisfy the gate", () => {
    const entries = [logEntry({ target: "searxng", deep: true, contentDigest: null })];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), ["searxng"]);
  });

  it("a staged skill whose index could not be read (no digest) is missing", () => {
    const entries = [logEntry({ target: "searxng", deep: true })];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, new Map()), ["searxng"]);
  });

  it("a Windows path target matches its skill name", () => {
    const entries = [logEntry({ target: ".claude\\skills\\searxng", deep: true })];
    assert.deepEqual(missingDeepSkillTriage(["searxng"], entries, NOW, DIGESTS), []);
  });

  it("mixes satisfied and missing skills correctly", () => {
    const entries = [
      logEntry({ target: "searxng", deep: true, timestamp: "2026-07-10T00:00:00Z" }), // fresh deep
      logEntry({ target: "triage", deep: false, timestamp: "2026-07-10T00:00:00Z" }), // shallow
    ];
    assert.deepEqual(
      missingDeepSkillTriage(["searxng", "triage", "new"], entries, NOW, DIGESTS).sort(),
      ["new", "triage"],
    );
  });
});
