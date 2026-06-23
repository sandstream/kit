import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  artifactForClass,
  findingMarker,
  healthToRedFindings,
  buildProposal,
  buildProposals,
  applyDedup,
  parseSuppressions,
  runSentinel,
  proposalSummary,
  sentinelStatusLine,
  sentinelWorkflow,
  SENTINEL_CACHE,
  type RedFinding,
} from "./sentinel.js";
import type { HealthFinding } from "./health.js";

describe("artifactForClass", () => {
  it("maps class → artifact", () => {
    assert.equal(artifactForClass("code"), "draft-pr");
    assert.equal(artifactForClass("human"), "issue");
    assert.equal(artifactForClass("noise"), "suppression-pr");
  });
});

describe("healthToRedFindings", () => {
  const findings: HealthFinding[] = [
    {
      sensor: "vercel",
      source: "team/p",
      status: "red",
      title: "prod deploy failed",
      suggestedClass: "code",
    },
    {
      sensor: "resend",
      source: "resend",
      status: "red",
      title: "domain unverified",
      suggestedClass: "human",
    },
    { sensor: "sentry", source: "o/p", status: "green", title: "ok" },
    { sensor: "gitlab", source: "g/r", status: "red", title: "pipeline failed" }, // no class → human
  ];
  it("keeps only red, maps class (default human), stable id per sensor", () => {
    const red = healthToRedFindings(findings);
    assert.equal(red.length, 3);
    assert.deepEqual(
      red.map((r) => r.id),
      ["health:vercel", "health:resend", "health:gitlab"],
    );
    assert.equal(red.find((r) => r.id === "health:vercel")!.class, "code");
    assert.equal(red.find((r) => r.id === "health:gitlab")!.class, "human");
  });
});

describe("buildProposal", () => {
  it("code → draft-pr with a branch and the dedup marker in the body", () => {
    const p = buildProposal({
      id: "health:vercel",
      class: "code",
      title: "deploy failed",
      detail: "ERROR state",
    });
    assert.equal(p.artifact, "draft-pr");
    assert.equal(p.branch, "kit/sentinel/health-vercel");
    assert.ok(p.body.includes(findingMarker("health:vercel")));
    assert.deepEqual(p.labels, ["kit-sentinel", "code"]);
  });
  it("human → issue, no branch", () => {
    const p = buildProposal({ id: "health:resend", class: "human", title: "domain unverified" });
    assert.equal(p.artifact, "issue");
    assert.equal(p.branch, undefined);
  });
  it("noise → suppression-pr with a suppress title + command", () => {
    const p = buildProposal({ id: "x:y", class: "noise", title: "benign" });
    assert.equal(p.artifact, "suppression-pr");
    assert.match(p.title, /suppress x:y/);
    assert.ok(p.suggestedCommands?.some((c) => c.includes("sentinel-suppress.toml")));
  });
});

describe("buildProposals + suppression", () => {
  const red: RedFinding[] = [
    { id: "health:vercel", class: "code", title: "a" },
    { id: "health:resend", class: "human", title: "b" },
  ];
  it("drops suppressed findings", () => {
    const out = buildProposals(red, new Set(["health:resend"]));
    assert.equal(out.length, 1);
    assert.equal(out[0].findingId, "health:vercel");
  });
});

describe("applyDedup", () => {
  const proposals = buildProposals([{ id: "health:vercel", class: "code", title: "a" }]);
  it("sets alreadyOpen from markers; null when not checked", () => {
    assert.equal(applyDedup(proposals, new Set(["health:vercel"]))[0].alreadyOpen, true);
    assert.equal(applyDedup(proposals, new Set(["other"]))[0].alreadyOpen, false);
    assert.equal(applyDedup(proposals, null)[0].alreadyOpen, null);
  });
});

describe("parseSuppressions", () => {
  it("reads the suppress = [...] array", () => {
    const ids = parseSuppressions('# note\nsuppress = ["health:resend", "x:y"]\n');
    assert.deepEqual([...ids].sort(), ["health:resend", "x:y"]);
  });
  it("empty when absent", () => {
    assert.equal(parseSuppressions("nothing here").size, 0);
  });
});

describe("runSentinel (gather → build → dedup)", () => {
  it("wires deps and produces deduped proposals (no suppress file in /tmp)", async () => {
    const out = await runSentinel("/tmp/nonexistent-kit-repo", {
      gatherRed: async () => [{ id: "health:vercel", class: "code", title: "deploy failed" }],
      openMarkers: async () => new Set(["health:vercel"]),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].alreadyOpen, true);
  });
});

describe("proposalSummary (#53 L3)", () => {
  const red: RedFinding[] = [
    { id: "health:vercel", class: "code", title: "deploy failed" },
    { id: "health:resend", class: "human", title: "domain unverified" },
    { id: "x:y", class: "noise", title: "benign" },
  ];
  it("counts total, fresh (not already open), and per-class", () => {
    // only the code finding already has an open artifact
    const proposals = applyDedup(buildProposals(red), new Set(["health:vercel"]));
    const s = proposalSummary(proposals);
    assert.equal(s.total, 3);
    assert.equal(s.fresh, 2); // resend + x:y fresh; vercel already open
    assert.deepEqual(s.byClass, { code: 1, human: 1, noise: 1 });
  });
  it("treats unchecked dedup (null) as fresh", () => {
    const s = proposalSummary(applyDedup(buildProposals(red), null));
    assert.equal(s.fresh, 3);
  });
});

describe("sentinelStatusLine (#53 surface)", () => {
  it("is null when nothing fresh (or no cache)", () => {
    assert.equal(sentinelStatusLine(null), null);
    assert.equal(
      sentinelStatusLine({ total: 2, fresh: 0, byClass: { code: 0, human: 0, noise: 0 } }),
      null,
    );
  });
  it("renders fresh count, and flags human items needing the user", () => {
    assert.equal(
      sentinelStatusLine({ total: 3, fresh: 3, byClass: { code: 2, human: 1, noise: 0 } }),
      "[sentinel · 3 fresh, 1 need you]",
    );
    assert.equal(
      sentinelStatusLine({ total: 1, fresh: 1, byClass: { code: 1, human: 0, noise: 0 } }),
      "[sentinel · 1 fresh]",
    );
  });
});

describe("sentinelWorkflow (#53 scheduler)", () => {
  it("emits a runnable GHA workflow with the default weekly cron", () => {
    const wf = sentinelWorkflow();
    assert.match(wf, /cron: "0 7 \* \* 1"/);
    assert.match(wf, /kit sentinel run --json/);
    assert.match(wf, /name: kit-sentinel/);
    // GHA expression survived the template literal (not interpolated to empty)
    assert.ok(wf.includes("${{ github.token }}"));
  });
  it("honours a custom schedule", () => {
    assert.match(sentinelWorkflow("0 0 * * *"), /cron: "0 0 \* \* \*"/);
  });
});

describe("SENTINEL_CACHE", () => {
  it("points under the .kit dir", () => {
    assert.equal(SENTINEL_CACHE, ".kit/sentinel.json");
  });
});
