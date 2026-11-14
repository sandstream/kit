import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestCloudflareAudit } from "./ingest-cloudflare-audit.js";
import { ingest, ingestStrict } from "./ingest.js";

// Shapes follow the skill's own validator fixtures (validate-findings.test.cjs, MIT), trimmed to
// the fields kit reads plus a few it ignores.
const step = (kind: string, file = "src/handler.c", line = 10) => ({
  kind,
  file,
  line,
  scope: "handle",
  description: "The value reaches the operation.",
});

const confirmed = (overall = "medium") => ({
  verdict: "confirmed",
  fingerprint: "src-handler-missing-check",
  title: "Missing ownership check",
  description: "An attacker can reach an operation without the intended ownership check.",
  trace: [
    step("entrypoint"),
    step("propagation", "src/model.c", 20),
    step("sink", "src/store.c", 30),
  ],
  evidence: [{ file: "src/handler.c", line: 10, description: "No check." }],
  severity: {
    likelihood: { score: "medium", reason: "Reachable." },
    impact: { score: "medium", reason: "One object." },
    overall_severity: overall,
  },
});

const needsValidation = () => ({
  verdict: "needs_validation",
  fingerprint: "src-parser-size-hypothesis",
  title: "Unchecked parsed size",
  description: "A parsed size may reach an allocation without a limit.",
  trace: [step("entrypoint", "src/parse.c", 7)],
  blockers: ["The generated parser source is absent."],
});

const rejected = () => ({
  verdict: "rejected",
  fingerprint: "src-router-auth-bypass",
  title: "Authorization bypass in router",
  trace: [step("sink")],
  reason: "All routes pass through the authorization wrapper.",
});

describe("ingestCloudflareAudit", () => {
  it("maps confirmed to a failure at its overall severity, pointing at the sink", () => {
    const outcome = ingestCloudflareAudit([confirmed("high")]);
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.findings, [
      {
        category: "exposure",
        name: "cloudflare-audit: src-handler-missing-check",
        status: "fail",
        detail: "Missing ownership check (src/store.c:30)",
        severity: "high",
      },
    ]);
    assert.deepEqual(outcome.notes, []);
  });

  it("maps informational to low, since kit has no lower severity", () => {
    const outcome = ingestCloudflareAudit([confirmed("informational")]);
    assert.ok(outcome.ok);
    assert.equal(outcome.findings[0].severity, "low");
  });

  it("maps needs_validation to a low warning marked unverified", () => {
    const outcome = ingestCloudflareAudit([needsValidation()]);
    assert.ok(outcome.ok);
    assert.equal(outcome.findings[0].status, "warn");
    assert.equal(outcome.findings[0].severity, "low");
    assert.equal(
      outcome.findings[0].detail,
      "unverified, needs validation: Unchecked parsed size (src/parse.c:7)",
    );
  });

  it("counts rejected records in a note and never ingests them", () => {
    const outcome = ingestCloudflareAudit([confirmed(), needsValidation(), rejected()]);
    assert.ok(outcome.ok);
    assert.equal(outcome.findings.length, 2);
    assert.ok(outcome.findings.every((f) => !f.name.includes("src-router-auth-bypass")));
    assert.deepEqual(outcome.notes, [
      "1 candidate(s) the audit rejected were counted, not ingested.",
    ]);
  });

  it("accepts an empty report as a report that found nothing", () => {
    assert.deepEqual(ingestCloudflareAudit([]), { ok: true, findings: [], notes: [] });
  });
});

describe("ingestCloudflareAudit refusals", () => {
  const broken: Array<[string, unknown]> = [
    ["not an array", { findings: [] }],
    ["null record", [null]],
    ["unknown verdict", [{ ...confirmed(), verdict: "maybe" }]],
    ["missing fingerprint", [{ ...confirmed(), fingerprint: "" }]],
    ["missing title", [{ ...needsValidation(), title: 42 }]],
    ["empty trace", [{ ...confirmed(), trace: [] }]],
    ["trace line zero", [{ ...confirmed(), trace: [step("sink", "a.c", 0)] }]],
    ["trace line fraction", [{ ...confirmed(), trace: [step("sink", "a.c", 1.5)] }]],
    ["trace without file", [{ ...confirmed(), trace: [{ kind: "sink", line: 3 }] }]],
    ["confirmed without severity", [{ ...confirmed(), severity: undefined }]],
    ["confirmed with unknown severity", [confirmed("severe")]],
    [
      "repeated fingerprint",
      [confirmed(), { ...needsValidation(), fingerprint: confirmed().fingerprint }],
    ],
  ];
  for (const [label, value] of broken) {
    it(`refuses the whole report on ${label}`, () => {
      const outcome = ingestCloudflareAudit(value);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.reason, /Cloudflare audit/);
    });
  }

  it("is reached through ingestStrict and ingest", () => {
    const json = JSON.stringify([confirmed(), rejected()]);
    const strict = ingestStrict("cloudflare-audit", json);
    assert.ok(strict.ok);
    assert.equal(strict.findings.length, 1);
    assert.deepEqual(ingest("cloudflare-audit", json), strict.findings);
    assert.deepEqual(ingest("cloudflare-audit", "[null]"), []);
    assert.equal(ingestStrict("cloudflare-audit", "not json").ok, false);
  });
});
