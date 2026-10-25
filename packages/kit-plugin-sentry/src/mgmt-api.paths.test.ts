import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getIssueEvents, issuePath, makeClient, updateIssue } from "./mgmt-api.js";

const token = "sntryu_" + "x".repeat(40);

describe("issuePath", () => {
  it("uses the org-scoped form Sentry documents whenever an organization is known", () => {
    const client = makeClient({ token, organizationSlug: "acme" });
    assert.equal(issuePath(client, "42"), "/api/0/organizations/acme/issues/42/");
    assert.equal(issuePath(client, "42", "other"), "/api/0/organizations/other/issues/42/");
  });

  it("falls back to the short form only without an organization", () => {
    assert.equal(issuePath(makeClient({ token }), "42"), "/api/0/issues/42/");
  });
});

describe("issue calls use the org-scoped path", () => {
  it("updateIssue and getIssueEvents call /organizations/{org}/issues/{id}/", async () => {
    const priorFetch = globalThis.fetch;
    const priorReadOnly = process.env.KIT_READ_ONLY;
    delete process.env.KIT_READ_ONLY;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(String(url).includes("/events/") ? "[]" : "{}", { status: 200 });
    }) as typeof fetch;
    try {
      const client = makeClient({
        token,
        organizationSlug: "acme",
        host: "https://sentry.example.test",
      });
      await updateIssue(client, "42", { status: "resolved" });
      await getIssueEvents(client, "42");
      assert.deepEqual(
        urls.map((u) => new URL(u).pathname),
        ["/api/0/organizations/acme/issues/42/", "/api/0/organizations/acme/issues/42/events/"],
      );
    } finally {
      globalThis.fetch = priorFetch;
      if (priorReadOnly !== undefined) process.env.KIT_READ_ONLY = priorReadOnly;
    }
  });
});
