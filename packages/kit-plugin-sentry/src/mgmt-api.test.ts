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

describe("policy refusals", () => {
  afterEach(() => {
    delete process.env.KIT_POLICY_DENY;
    delete process.env.KIT_READ_ONLY;
  });

  it("updateIssue refuses when the project has not pre-approved resolve_issue", async () => {
    // The value is what kit exports from `[policy.agent_writes]` after resolving it — the plugin
    // never sees the config, only the decision. See `policyDenyList` in kit-core.
    process.env.KIT_POLICY_DENY = "sentry:resolve_issue";
    const client = makeClient({ token: "x", organizationSlug: "demo" });
    await assert.rejects(
      () => updateIssue(client, "ABC-1", { status: "resolved" }),
      /refused by \[policy\.agent_writes\.sentry\].*resolve_issue/,
    );
  });

  it("createRelease refuses when the project has not pre-approved create_release", async () => {
    process.env.KIT_POLICY_DENY = "sentry:create_release";
    const client = makeClient({ token: "x", organizationSlug: "demo" });
    await assert.rejects(
      () => createRelease(client, { version: "v1.0.0", projects: ["my-proj"] }),
      /refused by \[policy\.agent_writes\.sentry\].*create_release/,
    );
  });

  it("a denial of ONE op does not refuse the other", async () => {
    // Per-op, not per-vendor: `sentry = ["resolve_issue"]` pre-approves triaging and nothing else,
    // so the release marker must be the only thing refused. A vendor-level check would collapse
    // these and make the operator's narrower grant meaningless.
    process.env.KIT_POLICY_DENY = "sentry:create_release";
    const client = makeClient({
      token: "x",
      host: "https://127.0.0.1:1",
      organizationSlug: "demo",
    });
    // Not refused by policy — it gets as far as the network, which is unreachable here.
    await assert.rejects(
      () => updateIssue(client, "ABC-1", { status: "resolved" }),
      (err: Error) => !/refused by \[policy/.test(err.message),
    );
  });

  it("read-only wins over policy, so a locked repo is not told to edit its config", async () => {
    process.env.KIT_READ_ONLY = "1";
    process.env.KIT_POLICY_DENY = "sentry:resolve_issue";
    const client = makeClient({ token: "x", organizationSlug: "demo" });
    await assert.rejects(
      () => updateIssue(client, "ABC-1", { status: "resolved" }),
      /read-only mode active/,
    );
  });

  it("an unset deny list refuses nothing — absence is not a denial", async () => {
    delete process.env.KIT_POLICY_DENY;
    const client = makeClient({
      token: "x",
      host: "https://127.0.0.1:1",
      organizationSlug: "demo",
    });
    await assert.rejects(
      () => createRelease(client, { version: "v1.0.0", projects: ["p"] }),
      (err: Error) => !/refused by \[policy/.test(err.message),
    );
  });
});
