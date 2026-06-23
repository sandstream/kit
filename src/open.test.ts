import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { listServices, findService, getServiceUrl, openService, openInBrowser } from "./open.js";

describe("openService", () => {
  // Force non-interactive so openInBrowser never spawns a real browser window
  // during the suite (Stripe's dashboard URL would otherwise pop open). Hermetic
  // regardless of how this file is run, not just via the npm test env.
  const prev = process.env.KIT_NON_INTERACTIVE;
  before(() => {
    process.env.KIT_NON_INTERACTIVE = "1";
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_NON_INTERACTIVE;
    else process.env.KIT_NON_INTERACTIVE = prev;
  });

  it("lists all services", () => {
    const services = listServices();
    assert.ok(services.length > 0, "Should have at least one service");
    assert.ok(
      services.some((s) => s.name === "stripe"),
      "Should include stripe",
    );
    assert.ok(
      services.some((s) => s.name === "vercel"),
      "Should include vercel",
    );
  });

  it("finds service by name (case insensitive)", () => {
    const service1 = findService("stripe");
    const service2 = findService("STRIPE");
    const service3 = findService("Stripe");

    assert.ok(service1, "Should find stripe");
    assert.ok(service2, "Should find STRIPE");
    assert.ok(service3, "Should find Stripe");
    assert.equal(service1?.name, "stripe");
    assert.equal(service2?.name, "stripe");
    assert.equal(service3?.name, "stripe");
  });

  it("returns undefined for unknown service", () => {
    const service = findService("nonexistent-service");
    assert.equal(service, undefined);
  });

  it("provides basic service metadata", () => {
    const stripe = findService("stripe");
    assert.ok(stripe, "Should find stripe");
    assert.equal(stripe.name, "stripe");
    assert.ok(stripe.label, "Should have label");
    assert.ok(stripe.docUrl, "Should have doc URL");
  });

  it("gets stripe dashboard URL", () => {
    const url = getServiceUrl("stripe", {});
    assert.equal(url, "https://dashboard.stripe.com");
  });

  it("gets vercel dashboard URL", () => {
    const url = getServiceUrl("vercel", {});
    assert.equal(url, "https://vercel.com/dashboard");
  });

  it("gets railway dashboard URL", () => {
    const url = getServiceUrl("railway", {});
    assert.equal(url, "https://railway.app/dashboard");
  });

  it("gets supabase URL with project ref from env", () => {
    const env = { SUPABASE_PROJECT_REF: "my-project" };
    const url = getServiceUrl("supabase", env);
    assert.equal(url, "https://supabase.com/dashboard/project/my-project");
  });

  it("falls back to base supabase URL when no project ref", () => {
    const url = getServiceUrl("supabase", {});
    assert.equal(url, "https://supabase.com/dashboard");
  });

  it("returns null for unknown service URL lookup", () => {
    const url = getServiceUrl("nonexistent", {});
    assert.equal(url, null);
  });

  it("returns proper result for valid service", async () => {
    // openInBrowser is a no-op here (KIT_NON_INTERACTIVE set above) — it returns
    // the URL instead of spawning a browser, so this stays hermetic.
    const result = await openService("stripe", {});

    assert.ok(result, "Should return result object");
    assert.ok(typeof result.success === "boolean", "Should have success boolean");
    assert.ok(typeof result.message === "string", "Should have message");
    assert.ok(typeof result.url === "string", "Should have URL");
    assert.ok(result.url.includes("stripe"), "URL should be stripe dashboard");
  });

  it("returns error for unknown service", async () => {
    const result = await openService("nonexistent-service", {});

    assert.equal(result.success, false);
    assert.ok(result.message.includes("Unknown service"));
    assert.equal(result.url, "");
  });

  it("openInBrowser never spawns a browser in non-interactive mode", async () => {
    // Guards against the regression where the suite popped Stripe's dashboard.
    const result = await openInBrowser("https://dashboard.stripe.com");
    assert.equal(result.success, true);
    assert.match(result.message, /visit: https:\/\/dashboard\.stripe\.com/i);
  });

  it("includes correct service label in dashboard URLs", () => {
    const services = listServices();
    const sentry = services.find((s) => s.name === "sentry");

    assert.ok(sentry, "Should have sentry service");
    assert.equal(sentry.label, "Sentry Dashboard");
    assert.ok(sentry.dashboardUrl, "Should have dashboardUrl function");
  });

  it("handles services with docs option", () => {
    const stripe = findService("stripe");
    assert.ok(stripe?.docUrl, "Should have doc URL");
    assert.ok(stripe.docUrl.includes("stripe.com"));
  });

  it("all services have required properties", () => {
    const services = listServices();

    for (const service of services) {
      assert.ok(service.name, `Service ${service.name} should have name`);
      assert.ok(service.label, `Service ${service.name} should have label`);
      assert.ok(service.docUrl, `Service ${service.name} should have docUrl`);
      assert.ok(
        typeof service.dashboardUrl === "function",
        `Service ${service.name} should have dashboardUrl function`,
      );
    }
  });

  it("github service maps to github.com", () => {
    const url = getServiceUrl("github", {});
    assert.equal(url, "https://github.com");
  });

  it("docs service maps to kit repo", () => {
    const url = getServiceUrl("docs", {});
    assert.equal(url, "https://github.com/sandstream/kit");
  });

  it("service name matching is case insensitive in getServiceUrl", () => {
    const url1 = getServiceUrl("stripe", {});
    const url2 = getServiceUrl("STRIPE", {});
    const url3 = getServiceUrl("Stripe", {});

    assert.equal(url1, url2);
    assert.equal(url2, url3);
  });

  it("handles env with multiple variables for URL construction", () => {
    const env = {
      SUPABASE_PROJECT_REF: "abc123",
      OTHER_VAR: "value",
      ANOTHER: "data",
    };
    const url = getServiceUrl("supabase", env);
    assert.equal(url, "https://supabase.com/dashboard/project/abc123");
  });
});
