import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { propagate, vercelEnvAddArgs } from "./secrets-propagate.js";

// A Vercel project in memory. It behaves like the real API where it matters here: a second variable
// with the same key and target is refused (409), and a PATCH changes the value but never the type,
// so an `encrypted` entry can only be replaced, not converted.
type Entry = { id: string; key: string; target: string[]; type: string; value: string };

class FakeVercel {
  entries: Entry[] = [];
  calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  failCreate = false;
  private n = 0;

  add(key: string, target: string[], type: string, value = "old"): Entry {
    const e = { id: `env_${++this.n}`, key, target, type, value };
    this.entries.push(e);
    return e;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    this.calls.push({ method, url, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    const id = /\/env\/([^/?]+)/.exec(url)?.[1];
    if (method === "GET") {
      return json(200, { envs: this.entries.map(({ value: _v, ...rest }) => rest) });
    }
    if (method === "POST") {
      if (this.failCreate) return json(500, { error: { message: "boom" } });
      const target = (body?.target ?? []) as string[];
      const clash = this.entries.some(
        (e) => e.key === body?.key && e.target.some((t) => target.includes(t)),
      );
      if (clash) return json(409, { error: { code: "ENV_CONFLICT" } });
      const e = this.add(String(body?.key), target, String(body?.type), String(body?.value));
      return json(200, { id: e.id, key: e.key, target: e.target });
    }
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return json(404, { error: { code: "not_found" } });
    if (method === "PATCH") {
      if (typeof body?.value === "string") entry.value = body.value;
      return json(200, { id: entry.id, key: entry.key, target: entry.target });
    }
    if (method === "DELETE") {
      this.entries = this.entries.filter((e) => e.id !== id);
      return json(200, {});
    }
    return json(405, {});
  }) as typeof fetch;
}

let api: FakeVercel;
let priorFetch: typeof fetch;
let priorToken: string | undefined;

beforeEach(() => {
  api = new FakeVercel();
  priorFetch = globalThis.fetch;
  priorToken = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = "test-token";
  globalThis.fetch = api.fetch;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  if (priorToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = priorToken;
});

const push = (env: "production" | "preview" | "development", value = "new-secret-value") =>
  propagate("API_KEY", value, ["vercel"], { env, vercelProject: "app" });

describe("a new Vercel variable is created sensitive", () => {
  for (const env of ["production", "preview"] as const) {
    it(`for ${env}`, async () => {
      const [r] = await push(env);
      assert.equal(r.ok, true, r.detail);
      assert.equal(api.entries.length, 1);
      assert.equal(api.entries[0].type, "sensitive");
      assert.deepEqual(api.entries[0].target, [env]);
    });
  }

  it("except for development, which Vercel does not allow to be sensitive, and it says so", async () => {
    const [r] = await push("development");
    assert.equal(r.ok, true, r.detail);
    assert.equal(api.entries[0].type, "encrypted");
    assert.match(r.detail, /development/);
    assert.match(r.detail, /not sensitive|cannot be sensitive/i);
  });
});

describe("an existing Vercel variable", () => {
  it("that is already sensitive gets a PATCH of the value and nothing else", async () => {
    api.add("API_KEY", ["production"], "sensitive");
    const [r] = await push("production");
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(
      api.calls.filter((c) => c.method !== "GET").map((c) => c.method),
      ["PATCH"],
    );
    assert.equal(api.entries[0].type, "sensitive");
    assert.equal(api.entries[0].value, "new-secret-value");
  });

  for (const type of ["encrypted", "plain", "secret"]) {
    it(`of type ${type} is replaced, because a type cannot be changed afterwards`, async () => {
      api.add("API_KEY", ["production"], type);
      const [r] = await push("production");
      assert.equal(r.ok, true, r.detail);
      const writes = api.calls.filter((c) => c.method !== "GET").map((c) => c.method);
      assert.deepEqual(
        writes,
        ["DELETE", "POST"],
        "delete first: a second entry for the same target is refused",
      );
      assert.equal(api.entries.length, 1);
      assert.equal(api.entries[0].type, "sensitive");
      assert.equal(api.entries[0].value, "new-secret-value");
    });
  }

  it("is replaced for development as encrypted, not sensitive", async () => {
    api.add("API_KEY", ["development"], "plain");
    const [r] = await push("development");
    assert.equal(r.ok, true, r.detail);
    assert.equal(api.entries[0].type, "encrypted");
  });

  it("is reported as not replaced when the create fails after the delete, with what to do", async () => {
    api.add("API_KEY", ["production"], "encrypted");
    api.failCreate = true;
    const [r] = await push("production");
    assert.equal(r.ok, false);
    assert.match(r.detail, /deleted/i);
    assert.match(r.detail, /run (it|the command) again|re-run/i);
    assert.equal(api.entries.length, 0);
  });

  it("never lets the value into a URL, a result or an error", async () => {
    api.add("API_KEY", ["production"], "encrypted");
    const [r] = await push("production", "very-secret-0123456789");
    assert.ok(api.calls.every((c) => !c.url.includes("very-secret")));
    assert.ok(!r.detail.includes("very-secret"));
    assert.equal(r.valueInArgv, false);
  });
});

describe("vercelEnvAddArgs, the CLI path used when there is no API token", () => {
  it("asks for a sensitive value for production and preview", () => {
    for (const env of ["production", "preview"] as const) {
      assert.ok(vercelEnvAddArgs("API_KEY", env, {}).includes("--sensitive"), env);
    }
  });

  it("does not for development", () => {
    assert.ok(!vercelEnvAddArgs("API_KEY", "development", {}).includes("--sensitive"));
  });

  it("keeps the name and environment first and never carries a value", () => {
    const args = vercelEnvAddArgs("API_KEY", "production", {
      vercelScope: "team",
      vercelCwd: "web",
    });
    assert.deepEqual(args.slice(0, 4), ["env", "add", "API_KEY", "production"]);
    assert.ok(args.includes("--scope") && args.includes("--cwd"));
    assert.ok(!args.includes("--value"));
  });
});
