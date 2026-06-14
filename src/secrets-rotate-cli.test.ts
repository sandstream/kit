import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identifyProvider, buildPlaybook } from "./secrets-rotate-cli.js";

describe("identifyProvider", () => {
  it("classifies Stripe keys", () => {
    assert.equal(identifyProvider("STRIPE_SECRET_KEY"), "stripe");
    assert.equal(identifyProvider("STRIPE_PUBLISHABLE_KEY"), "stripe");
    assert.equal(identifyProvider("STRIPE_WEBHOOK_SECRET"), "stripe");
  });

  it("classifies AWS IAM keys", () => {
    assert.equal(identifyProvider("AWS_ACCESS_KEY_ID"), "aws-iam");
    assert.equal(identifyProvider("AWS_SECRET_ACCESS_KEY"), "aws-iam");
  });

  it("classifies GCP keys", () => {
    assert.equal(identifyProvider("GCP_SERVICE_ACCOUNT_JSON"), "gcp-iam");
  });

  it("classifies GitHub PATs", () => {
    assert.equal(identifyProvider("GITHUB_TOKEN"), "github-pat");
    assert.equal(identifyProvider("GH_TOKEN"), "github-pat");
  });

  it("classifies OpenAI keys", () => {
    assert.equal(identifyProvider("OPENAI_API_KEY"), "openai");
  });

  it("returns unknown for unrecognized names", () => {
    assert.equal(identifyProvider("RANDOM_KEY"), "unknown");
    assert.equal(identifyProvider("MY_API"), "unknown");
  });
});

describe("buildPlaybook", () => {
  it("returns a non-empty playbook for known providers", () => {
    for (const p of ["STRIPE_SECRET_KEY", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY"]) {
      const pb = buildPlaybook(p);
      assert.ok(pb.steps.length > 0);
      assert.ok(pb.newValueSource.length > 0);
      assert.ok(pb.docsUrl);
    }
  });

  it("returns an unknown-provider playbook for unrecognized names", () => {
    const pb = buildPlaybook("RANDOM_KEY");
    assert.equal(pb.provider, "unknown");
    assert.ok(pb.steps.length > 0);
  });

  it("includes a revoke step for providers that support revocation", () => {
    const stripe = buildPlaybook("STRIPE_SECRET_KEY");
    assert.ok(stripe.revokeStep);
    assert.ok(stripe.revokeStep!.includes("revoke") || stripe.revokeStep!.includes("delete"));
    const aws = buildPlaybook("AWS_ACCESS_KEY_ID");
    assert.ok(aws.revokeStep);
  });
});
