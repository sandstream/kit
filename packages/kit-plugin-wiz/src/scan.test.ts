import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeClient,
  recordWizIssues,
  fetchIssues,
  type WizIssue,
} from "./scan.js";

const SAMPLE_ISSUE: WizIssue = {
  id: "wiz-issue-1",
  severity: "HIGH",
  status: "OPEN",
  type: "WIZ_CONTROL",
  entitySnapshot: {
    type: "VIRTUAL_MACHINE",
    name: "prod-app-01",
    cloudPlatform: "AWS",
    subscriptionExternalId: "111122223333",
    region: "us-east-1",
  },
  controlId: "wc-id-1",
  controlName: "VM exposes SSH to the internet",
  createdAt: "2026-06-08T10:00:00Z",
};

describe("makeClient", () => {
  it("refuses without WIZ_CLIENT_ID / WIZ_CLIENT_SECRET", async () => {
    const prevId = process.env.WIZ_CLIENT_ID;
    const prevSecret = process.env.WIZ_CLIENT_SECRET;
    delete process.env.WIZ_CLIENT_ID;
    delete process.env.WIZ_CLIENT_SECRET;
    try {
      await assert.rejects(
        () => makeClient({}),
        /WIZ_CLIENT_ID \+ WIZ_CLIENT_SECRET required/,
      );
    } finally {
      if (prevId !== undefined) process.env.WIZ_CLIENT_ID = prevId;
      if (prevSecret !== undefined) process.env.WIZ_CLIENT_SECRET = prevSecret;
    }
  });

  it("refuses without WIZ_API_URL", async () => {
    await assert.rejects(
      () =>
        makeClient({ clientId: "x", clientSecret: "y" }),
      /WIZ_API_URL required/,
    );
  });

  it("surfaces auth-endpoint failure", async () => {
    await assert.rejects(() =>
      makeClient({
        clientId: "x",
        clientSecret: "y",
        apiUrl: "https://api.demo.wiz.io/graphql",
        authUrl: "https://127.0.0.1:1/oauth/token",
      }),
    );
  });
});

describe("fetchIssues", () => {
  it("throws on unreachable API", async () => {
    await assert.rejects(() =>
      fetchIssues(
        { apiUrl: "https://127.0.0.1:1/graphql", accessToken: "x" },
        { limit: 5 },
      ),
    );
  });
});

describe("recordWizIssues", () => {
  it("writes one JSONL line per issue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-wiz-"));
    try {
      const { written } = await recordWizIssues([SAMPLE_ISSUE], dir);
      assert.equal(written, 1);
      const text = readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8");
      const line = JSON.parse(text.trim());
      assert.equal(line.source, "wiz");
      assert.equal(line.severity, "high");
      assert.equal(line.cloud_platform, "AWS");
      assert.equal(line.title, "VM exposes SSH to the internet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns written:0 for empty input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-wiz-"));
    try {
      const { written } = await recordWizIssues([], dir);
      assert.equal(written, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
