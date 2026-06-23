import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  makeClient,
  listOrganizations,
  searchIssues,
  updateIssue,
  createRelease,
} from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when SENTRY_AUTH_TOKEN missing", () => {
    const prev = process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    try {
      assert.throws(() => makeClient(), /SENTRY_AUTH_TOKEN not set/);
    } finally {
      if (prev !== undefined) process.env.SENTRY_AUTH_TOKEN = prev;
    }
  });

  it("uses explicit token over env", () => {
    process.env.SENTRY_AUTH_TOKEN = "env-token";
    try {
      const client = makeClient({ token: "explicit-token" });
      const auth = (client.headers as Record<string, string>).Authorization;
      assert.equal(auth, "Bearer explicit-token");
    } finally {
      delete process.env.SENTRY_AUTH_TOKEN;
    }
  });

  it("defaults to sentry.io host", () => {
    const client = makeClient({ token: "x" });
    assert.equal(client.host, "https://sentry.io");
  });

  it("honors host override for EU + self-hosted", () => {
    const eu = makeClient({ token: "x", host: "https://de.sentry.io" });
    assert.equal(eu.host, "https://de.sentry.io");
    const selfHosted = makeClient({
      token: "x",
      host: "https://sentry.example.internal",
    });
    assert.equal(selfHosted.host, "https://sentry.example.internal");
  });

  it("honors SENTRY_URL env var when no host passed", () => {
    process.env.SENTRY_URL = "https://eu.sentry.io";
    try {
      const client = makeClient({ token: "x" });
      assert.equal(client.host, "https://eu.sentry.io");
    } finally {
      delete process.env.SENTRY_URL;
    }
  });
});

describe("listOrganizations (network error path)", () => {
  it("throws structured error when unreachable", async () => {
    const client = makeClient({ token: "x", host: "https://127.0.0.1:1" });
    await assert.rejects(() => listOrganizations(client));
  });
});

describe("searchIssues", () => {
  it("refuses without an organizationSlug", async () => {
    const client = makeClient({ token: "x" });
    await assert.rejects(() => searchIssues(client, {}), /organizationSlug required/);
  });

  it("throws structured error when unreachable", async () => {
    const client = makeClient({
      token: "x",
      host: "https://127.0.0.1:1",
      organizationSlug: "demo",
    });
    await assert.rejects(() => searchIssues(client, { query: "is:unresolved" }));
  });
});

describe("read-only refusals", () => {
  afterEach(() => {
    delete process.env.KIT_READ_ONLY;
  });

  it("updateIssue refuses when KIT_READ_ONLY=1", async () => {
    process.env.KIT_READ_ONLY = "1";
    const client = makeClient({ token: "x", organizationSlug: "demo" });
    await assert.rejects(
      () => updateIssue(client, "ABC-1", { status: "resolved" }),
      /read-only mode active/,
    );
  });

  it("createRelease refuses when KIT_READ_ONLY=1", async () => {
    process.env.KIT_READ_ONLY = "1";
    const client = makeClient({ token: "x", organizationSlug: "demo" });
    await assert.rejects(
      () =>
        createRelease(client, {
          version: "v1.0.0",
          projects: ["my-proj"],
        }),
      /read-only mode active/,
    );
  });
});
