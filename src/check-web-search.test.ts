import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { checkWebSearch } from "./check-web-search.js";

describe("checkWebSearch - no config", () => {
  it("returns not configured when no config provided", async () => {
    const result = await checkWebSearch(undefined);
    assert.equal(result.configured, false);
    assert.equal(result.healthy, false);
    assert.equal(result.provider, "none");
  });

  it("returns not configured when provider is missing", async () => {
    const result = await checkWebSearch({} as any);
    assert.equal(result.configured, false);
    assert.equal(result.provider, "none");
  });
});

describe("checkWebSearch - searxng", () => {
  afterEach(() => mock.restoreAll());

  it("returns not configured when URL is missing", async () => {
    const result = await checkWebSearch({ provider: "searxng" });
    assert.equal(result.configured, false);
    assert.ok(result.error?.includes("URL not configured"));
  });

  it("returns healthy when server responds with 200", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("", { status: 200 }),
    );

    const result = await checkWebSearch({
      provider: "searxng",
      url: "http://localhost:8080",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, true);
    assert.equal(result.url, "http://localhost:8080");
  });

  it("returns unhealthy when server returns non-ok status", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("", { status: 503 }),
    );

    const result = await checkWebSearch({
      provider: "searxng",
      url: "http://localhost:8080",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("503"));
  });

  it("returns unhealthy when server is unreachable", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await checkWebSearch({
      provider: "searxng",
      url: "http://localhost:8080",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("ECONNREFUSED"));
  });
});

describe("checkWebSearch - brave", () => {
  afterEach(() => mock.restoreAll());

  it("returns not configured when API key is missing", async () => {
    const result = await checkWebSearch({ provider: "brave" });
    assert.equal(result.configured, false);
    assert.ok(result.error?.includes("API key not configured"));
  });

  it("returns healthy when API key is valid (200 response)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    const result = await checkWebSearch({
      provider: "brave",
      apiKey: "valid-key-123",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, true);
  });

  it("returns unhealthy on 401 (invalid key)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("Unauthorized", { status: 401 }),
    );

    const result = await checkWebSearch({
      provider: "brave",
      apiKey: "bad-key",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("Invalid"));
  });

  it("returns unhealthy on 403 (forbidden)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("Forbidden", { status: 403 }),
    );

    const result = await checkWebSearch({
      provider: "brave",
      apiKey: "bad-key",
    });

    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("Invalid"));
  });
});

describe("checkWebSearch - google", () => {
  afterEach(() => mock.restoreAll());

  it("returns not configured without apiKey + cx", async () => {
    const result = await checkWebSearch({ provider: "google" });
    assert.equal(result.configured, false);
    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("cx"));
  });

  it("returns healthy with valid apiKey + cx (200 response)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const result = await checkWebSearch({ provider: "google", apiKey: "k", cx: "engine-id" });
    assert.equal(result.configured, true);
    assert.equal(result.healthy, true);
  });

  it("returns unhealthy on 403 (invalid key or cx)", async () => {
    mock.method(globalThis, "fetch", async () => new Response("Forbidden", { status: 403 }));
    const result = await checkWebSearch({ provider: "google", apiKey: "k", cx: "x" });
    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("Invalid"));
  });
});

describe("checkWebSearch - custom", () => {
  afterEach(() => mock.restoreAll());

  it("returns not configured when URL is missing", async () => {
    const result = await checkWebSearch({ provider: "custom" });
    assert.equal(result.configured, false);
    assert.ok(result.error?.includes("URL not configured"));
  });

  it("returns healthy on 200", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("", { status: 200 }),
    );

    const result = await checkWebSearch({
      provider: "custom",
      url: "http://my-search.local",
    });

    assert.equal(result.healthy, true);
  });

  it("returns healthy on 404 (custom endpoints may lack health endpoint)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("Not Found", { status: 404 }),
    );

    const result = await checkWebSearch({
      provider: "custom",
      url: "http://my-search.local",
    });

    assert.equal(result.configured, true);
    assert.equal(result.healthy, true);
  });

  it("returns unhealthy on 500", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("Error", { status: 500 }),
    );

    const result = await checkWebSearch({
      provider: "custom",
      url: "http://my-search.local",
    });

    assert.equal(result.healthy, false);
    assert.ok(result.error?.includes("500"));
  });
});

describe("checkWebSearch - unknown provider", () => {
  it("returns error for unknown provider", async () => {
    const result = await checkWebSearch({ provider: "bing" as any });
    assert.equal(result.configured, false);
    assert.ok(result.error?.includes("Unknown provider"));
  });
});
