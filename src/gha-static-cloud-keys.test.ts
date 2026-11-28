/**
 * kit-research linkedin-batch-2026-11-27-vs-kit: a deploy workflow passed a stored AWS key pair to
 * aws-actions/configure-aws-credentials, and kit named the keys only inside the install-scripts
 * row. There was no row for a static key where OIDC would do.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditWorkflow } from "./gha-audit.js";
import { auditStaticCloudKeys } from "./gha-static-cloud-keys.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const names = (wf: string): string[] => auditStaticCloudKeys(wf, "w.yml").map((r) => r.name);
const job = (id: string, steps: string[]) =>
  [`  ${id}:`, "    runs-on: ubuntu-latest", "    steps:", ...steps].join("\n");

// AWS: "Configuring OpenID Connect in Amazon Web Services"
// https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services
// The action's own OIDC section: https://github.com/aws-actions/configure-aws-credentials#oidc
const AWS_KEYS = [
  `      - uses: aws-actions/configure-aws-credentials@${SHA}`,
  "        with:",
  "          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}",
  "          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}",
  "          aws-region: eu-north-1",
];
const AWS_OIDC = [
  `      - uses: aws-actions/configure-aws-credentials@${SHA}`,
  "        with:",
  "          role-to-assume: arn:aws:iam::123456789012:role/deploy",
  "          aws-region: eu-north-1",
];
// GCP: "Direct Workload Identity Federation" (preferred)
// https://github.com/google-github-actions/auth#preferred-direct-workload-identity-federation
const GCP_KEY = [
  `      - uses: google-github-actions/auth@${SHA}`,
  "        with:",
  "          credentials_json: ${{ secrets.GOOGLE_CREDENTIALS }}",
];
const GCP_OIDC = [
  `      - uses: google-github-actions/auth@${SHA}`,
  "        with:",
  "          workload_identity_provider: projects/1/locations/global/workloadIdentityPools/p/providers/gh",
];
// Azure: "Use the Azure Login action with OpenID Connect"
// https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect
// https://github.com/Azure/login#login-with-openid-connect-oidc-recommended
const AZURE_KEY = [
  `      - uses: Azure/login@${SHA}`,
  "        with:",
  "          creds: ${{ secrets.AZURE_CREDENTIALS }}",
];
const AZURE_OIDC = [
  `      - uses: azure/login@${SHA}`,
  "        with:",
  "          client-id: ${{ secrets.AZURE_CLIENT_ID }}",
  "          tenant-id: ${{ secrets.AZURE_TENANT_ID }}",
  "          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}",
];

describe("auditStaticCloudKeys: a static key where OIDC would do", () => {
  it("flags the AWS key pair passed to configure-aws-credentials (the note's deploy.yml)", () => {
    const wf = ["on: push", "jobs:", job("deploy", AWS_KEYS)].join("\n");
    const rows = auditStaticCloudKeys(wf, "deploy.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["static AWS key on job deploy (deploy.yml)"],
    );
    assert.match(rows[0]?.detail ?? "", /aws-access-key-id, .*aws-secret-access-key/);
    assert.match(rows[0]?.suggestion ?? "", /role-to-assume/);
    assert.match(rows[0]?.suggestion ?? "", /`id-token: write` on this job only/);
    assert.match(rows[0]?.suggestion ?? "", /configuring-openid-connect-in-amazon-web-services/);
    assert.equal(rows[0]?.severity, "medium");
  });

  it("flags AWS keys set from secrets in a step, job or workflow env", () => {
    const step = ["      - run: aws s3 sync dist s3://b", "        env:"];
    const keys = [
      "          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}",
      '          AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}"',
    ];
    assert.deepEqual(names(["jobs:", job("s3", [...step, ...keys])].join("\n")), [
      "static AWS key on job s3 (w.yml)",
    ]);
    const wfEnv = ["env:", "  AWS_ACCESS_KEY_ID: ${{ secrets.KEY }}", "jobs:", job("a", step)];
    assert.deepEqual(names(wfEnv.join("\n")), ["workflow-level static AWS key (w.yml)"]);
  });

  it("flags GCP credentials_json and Azure creds, naming each provider's OIDC inputs", () => {
    const wf = ["on: push", "jobs:", job("gcp", GCP_KEY), job("az", AZURE_KEY)].join("\n");
    const rows = auditStaticCloudKeys(wf, "w.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["static GCP key on job gcp (w.yml)", "static Azure key on job az (w.yml)"],
    );
    assert.match(rows[0]?.suggestion ?? "", /workload_identity_provider/);
    assert.match(rows[1]?.suggestion ?? "", /client-id`, `tenant-id` and `subscription-id/);
  });

  it("does not flag the OIDC forms, a commented key, or a key input on another action", () => {
    const wf = [
      "on: push",
      "jobs:",
      job("aws", AWS_OIDC),
      job("gcp", GCP_OIDC),
      job("az", AZURE_OIDC),
      job("other", [`      - uses: some/action@${SHA}`, "        with:", "          creds: x"]),
      job("note", ["      - run: echo ok", "        # AWS_ACCESS_KEY_ID: ${{ secrets.K }}"]),
    ].join("\n");
    assert.deepEqual(names(wf), []);
  });
});

describe("auditWorkflow includes the static-cloud-key rule", () => {
  it("reports it beside the other workflow findings", () => {
    const wf = ["on: push", "jobs:", job("deploy", AWS_KEYS)].join("\n");
    const rows = auditWorkflow(wf, "deploy.yml").map((r) => r.name);
    assert.ok(rows.includes("static AWS key on job deploy (deploy.yml)"), rows.join("\n"));
  });
});
