/**
 * kit-research claude-ship-vs-kit and wfx-github-actions-campaign-vs-kit: a required check that
 * names no source app accepts a same-named check from anyone who can write commit statuses. kit's
 * branch audit did not read required checks at all.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditRemoteRequiredChecks } from "./branch-protection-audit.js";
import {
  requiredCheckSources,
  requiredChecksFromClassic,
  requiredChecksFromRules,
} from "./required-check-source.js";

const rulesWith = (checks: Record<string, unknown>[]) => [
  { type: "pull_request", parameters: {} },
  { type: "required_status_checks", parameters: { required_status_checks: checks } },
];

describe("reading required checks", () => {
  it("reads contexts and the pinned app from rulesets", () => {
    assert.deepEqual(
      requiredChecksFromRules(
        rulesWith([{ context: "build-and-test", integration_id: 15368 }, { context: "lint" }]),
      ),
      [
        { context: "build-and-test", appId: 15368 },
        { context: "lint", appId: null },
      ],
    );
    assert.deepEqual(requiredChecksFromRules({}), []);
  });

  it("reads classic protection, where app_id -1 or null means any source", () => {
    assert.deepEqual(
      requiredChecksFromClassic({
        checks: [
          { context: "a", app_id: -1 },
          { context: "b", app_id: null },
          { context: "c", app_id: 7 },
        ],
      }),
      [
        { context: "a", appId: null },
        { context: "b", appId: null },
        { context: "c", appId: 7 },
      ],
    );
  });
});

describe("requiredCheckSources", () => {
  it("passes when every required check names its app", () => {
    const r = requiredCheckSources("main", [{ context: "ci", appId: 1 }], true);
    assert.equal(r.status, "pass");
    assert.match(r.detail ?? "", /1 required check\(s\), each accepted only from the app/);
  });

  it("warns on a check any source can report, naming it", () => {
    const r = requiredCheckSources(
      "main",
      [
        { context: "ci", appId: 1 },
        { context: "Claude Approvals", appId: null },
      ],
      true,
    );
    assert.equal(r.status, "warn");
    assert.match(
      r.detail ?? "",
      /1 of 2 required check\(s\) accept a result from any source: "Claude Approvals"/,
    );
  });

  it("counts a check pinned in a ruleset but open in classic protection as open", () => {
    const r = requiredCheckSources(
      "main",
      [
        { context: "ci", appId: 1 },
        { context: "ci", appId: null },
      ],
      true,
    );
    assert.equal(r.status, "warn");
  });

  it("says when classic protection could not be read", () => {
    const none = requiredCheckSources("main", [], false);
    assert.equal(none.status, "pass");
    assert.match(none.detail ?? "", /classic protection is not readable/);
  });
});

describe("auditRemoteRequiredChecks", () => {
  const fake =
    (rules: unknown, classic: { status: number; body: unknown }) =>
    async (input: string): Promise<Response> => {
      if (input.endsWith("/repos/o/r"))
        return new Response(JSON.stringify({ default_branch: "main" }));
      if (input.endsWith("/rules/branches/main")) return new Response(JSON.stringify(rules));
      if (input.endsWith("/protection/required_status_checks"))
        return new Response(JSON.stringify(classic.body), { status: classic.status });
      return new Response("{}", { status: 404 });
    };

  it("warns from the API answers, and reads a 403 on classic protection as not read", async () => {
    const r = await auditRemoteRequiredChecks(
      "https://github.com/o/r",
      "t",
      fake(rulesWith([{ context: "build" }]), { status: 403, body: {} }),
    );
    assert.equal(r.status, "warn");
    assert.match(r.detail ?? "", /"build".*classic protection is not readable/);
  });

  it("is unverified without a token or for GitLab", async () => {
    assert.equal((await auditRemoteRequiredChecks("https://github.com/o/r", null)).didNotRun, true);
    assert.equal((await auditRemoteRequiredChecks("https://gitlab.com/o/r", "t")).didNotRun, true);
  });
});
