import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderUsageMarkdown } from "./usage-markdown.js";
import type { UsageFacts } from "./usage-report.js";

const facts: UsageFacts = {
  coverage: { at: null, enumerated: 0, pass: 0, warn: 0, fail: 0, couldNotRun: [] },
  standards: { at: null, standards: [] },
  keys: {
    declared: 0,
    bySource: [],
    available: null,
    missing: [],
    history: null,
    envIgnored: null,
  },
  memory: {
    path: "/home/u/.kit/memory.db",
    bytes: 245760,
    messages: 0,
    sessions: 0,
    harnesses: [],
    projects: [],
    outputTokens: null,
    cacheReadTokens: null,
    windowDays: 7,
    syncConfigured: false,
  },
  floor: {
    events: 818,
    refusals: 497,
    byOperation: [
      ["policy-check", 294],
      ["odd|name", 3],
    ],
    bypassedCommits: 55,
    controls: 6,
    actorUnknown: true,
  },
  triage: { runs: 41, byType: [["npm", 18]], latest: { type: "pip", target: "fastmcp-slim" } },
  machine: { sealedRepos: 4, liveRepos: 3, sharedEntries: 52 },
};

describe("kit usage --markdown", () => {
  it("renders headings and tables a phone or chat reflows, with no box-drawing", () => {
    const md = renderUsageMarkdown(facts);
    assert.match(md, /^# kit usage\n/);
    assert.match(md, /\*\*818\*\* audited operations · \*\*497\*\* refused/);
    assert.match(md, /\| `policy-check` \| 294 \| ▰▰▰▰▰▰▱▱▱▱ \|/);
    assert.match(md, /`odd\\\|name`/, "a | in a cell is escaped so the table holds");
    const slash = renderUsageMarkdown({
      ...facts,
      floor: { ...facts.floor, byOperation: [["back\\|slash", 1]] },
    });
    assert.match(
      slash,
      /`back\\\\\\\|slash`/,
      "a backslash is escaped before the pipe it precedes",
    );
    assert.match(md, /⚠️ \*\*55\*\* commits bypassed the pre-commit hook/);
    assert.match(md, /_6 refusals by kit's own negative controls .* are not counted\._/);
    assert.match(md, /_No saved check run\. Run `kit check` once\._/);
    assert.match(md, /Latest: `pip fastmcp-slim`/);
    assert.doesNotMatch(md, /[│╭╮╰╯├┤─]/);
  });

  it("states that the proof was not run, and lists each control once it was", () => {
    assert.match(renderUsageMarkdown(facts), /_Not run\./);
    const proved = renderUsageMarkdown({
      ...facts,
      proof: {
        ok: false,
        controls: [
          {
            name: "install gate refuses an unverifiable install",
            expected: "refused",
            observed: "exit 2, blocked",
            verdict: "refused",
            ok: true,
          },
          {
            name: "pre-commit refuses a staged credential",
            expected: "refused",
            observed: "committed",
            verdict: "allowed",
            ok: false,
          },
        ],
      },
    });
    assert.match(
      proved,
      /\| ✅ install gate refuses an unverifiable install \| exit 2, blocked \|/,
    );
    assert.match(proved, /\| ❌ pre-commit refuses a staged credential \| committed \|/);
    assert.match(proved, /A control did not hold/);
  });
});
