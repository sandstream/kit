import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loginServices, type LoginDeps } from "./login.js";
import type { ServiceConfig } from "./config.js";

function makeDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    checkServices: async () => [],
    runLogin: async () => ({ ok: true, detail: "Login completed" }),
    runLink: async () => ({ ok: true, detail: "Link completed" }),
    runVerify: async () => ({ ok: true, output: "Logged in as user" }),
    ...overrides,
  };
}

const ghService: Record<string, ServiceConfig> = {
  github: { login: "gh auth login", check: "gh auth status" },
};

describe("loginServices", () => {
  it("skips already authenticated services", async () => {
    const deps = makeDeps({
      checkServices: async () => [
        { name: "github", checkCommand: "gh auth status", authenticated: true, output: "Logged in as octocat" },
      ],
    });

    const results = await loginServices(ghService, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "already_authenticated");
    assert.ok(results[0].detail.includes("octocat"));
  });

  it("fails when no login command configured", async () => {
    const services: Record<string, ServiceConfig> = {
      custom: { login: "", check: "custom check" },
    };
    const deps = makeDeps({
      checkServices: async () => [
        { name: "custom", checkCommand: "custom check", authenticated: false, output: "Not logged in" },
      ],
    });

    const results = await loginServices(services, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "failed");
    assert.ok(results[0].detail.includes("No login command"));
  });

  it("runs login and verifies successfully", async () => {
    const deps = makeDeps({
      checkServices: async () => [
        { name: "github", checkCommand: "gh auth status", authenticated: false, output: "" },
      ],
      runLogin: async (cmd) => {
        assert.equal(cmd, "gh auth login");
        return { ok: true, detail: "Login completed" };
      },
      runVerify: async (cmd) => {
        assert.equal(cmd, "gh auth status");
        return { ok: true, output: "Logged in as octocat" };
      },
    });

    const results = await loginServices(ghService, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "logged_in");
    assert.ok(results[0].detail.includes("octocat"));
  });

  it("returns login_unverified when verification fails", async () => {
    const deps = makeDeps({
      checkServices: async () => [
        { name: "github", checkCommand: "gh auth status", authenticated: false, output: "" },
      ],
      runLogin: async () => ({ ok: true, detail: "Login completed" }),
      runVerify: async () => ({ ok: false, output: "Command failed" }),
    });

    const results = await loginServices(ghService, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "login_unverified");
    assert.ok(results[0].detail.includes("verification failed"));
  });

  it("returns failed when login command fails", async () => {
    const deps = makeDeps({
      checkServices: async () => [
        { name: "github", checkCommand: "gh auth status", authenticated: false, output: "" },
      ],
      runLogin: async () => ({ ok: false, detail: "Login exited with code 1" }),
    });

    const results = await loginServices(ghService, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "failed");
    assert.ok(results[0].detail.includes("code 1"));
  });

  it("runs link command after login", async () => {
    const services: Record<string, ServiceConfig> = {
      supabase: {
        login: "supabase login",
        check: "supabase projects list",
        link: "supabase link --project-ref abc123",
      },
    };
    const linkCalls: string[] = [];

    const deps = makeDeps({
      checkServices: async () => [
        { name: "supabase", checkCommand: "supabase projects list", authenticated: false, output: "" },
      ],
      runLink: async (cmd) => {
        linkCalls.push(cmd);
        return { ok: true, detail: "Linked" };
      },
    });

    const results = await loginServices(services, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "logged_in");
    assert.deepEqual(linkCalls, ["supabase link --project-ref abc123"]);
  });

  it("returns login_unverified when link fails", async () => {
    const services: Record<string, ServiceConfig> = {
      supabase: {
        login: "supabase login",
        check: "supabase projects list",
        link: "supabase link --project-ref abc123",
      },
    };

    const deps = makeDeps({
      checkServices: async () => [
        { name: "supabase", checkCommand: "supabase projects list", authenticated: false, output: "" },
      ],
      runLink: async () => ({ ok: false, detail: "Project not found" }),
    });

    const results = await loginServices(services, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "login_unverified");
    assert.ok(results[0].detail.includes("link failed"));
  });

  it("handles multiple services with mixed results", async () => {
    const services: Record<string, ServiceConfig> = {
      github: { login: "gh auth login", check: "gh auth status" },
      vercel: { login: "vercel login", check: "vercel whoami" },
      stripe: { login: "stripe login", check: "stripe config --list" },
    };

    const deps = makeDeps({
      checkServices: async () => [
        { name: "github", checkCommand: "gh auth status", authenticated: true, output: "Logged in" },
        { name: "vercel", checkCommand: "vercel whoami", authenticated: false, output: "" },
        { name: "stripe", checkCommand: "stripe config --list", authenticated: false, output: "" },
      ],
      runLogin: async (cmd) => {
        if (cmd.includes("stripe")) return { ok: false, detail: "Login failed" };
        return { ok: true, detail: "Login completed" };
      },
      runVerify: async () => ({ ok: true, output: "OK" }),
    });

    const results = await loginServices(services, deps);

    assert.equal(results.length, 3);
    assert.equal(results[0].action, "already_authenticated");
    assert.equal(results[1].action, "logged_in");
    assert.equal(results[2].action, "failed");
  });

  it("never echoes secrets from an authenticated service's check output", async () => {
    // `stripe config --list` dumps the whole config including API keys. Build
    // the secret-SHAPED fixtures by concatenation so no contiguous secret
    // literal exists in source (platform secret-scanners flag those).
    const skBody = "51AbcdEfGhIjKlMnOpQrStUv";
    const pkBody = "51ZyXwVuTsRqPoNmLkJiHgFe";
    const stripeDump = [
      "color = ''",
      "['cdb agency-sandlåda']",
      `test_mode_api_key = '${"sk_" + "test_" + skBody}'`,
      `test_mode_pub_key = '${"pk_" + "test_" + pkBody}'`,
    ].join("\n");
    const deps = makeDeps({
      checkServices: async () => [
        { name: "stripe", checkCommand: "stripe config --list", authenticated: true, output: stripeDump },
      ],
    });

    const [result] = await loginServices(
      { stripe: { login: "stripe login", check: "stripe config --list" } },
      deps,
    );

    assert.equal(result.action, "already_authenticated");
    assert.ok(!result.detail.includes("\n"), "detail must be a single line");
    assert.ok(!result.detail.includes(skBody), "must not contain the secret key body");
    assert.ok(!result.detail.includes(pkBody), "must not contain the pub key body");
  });

  it("marks a service with an informational (no-CLI) login as manual, not failed", async () => {
    const services: Record<string, ServiceConfig> = {
      resend: { login: "# resend — no CLI login; set RESEND_API_KEY in env", check: "# check env" },
    };
    const deps = makeDeps({
      checkServices: async () => [
        { name: "resend", checkCommand: "# check env", authenticated: false, output: "" },
      ],
    });

    const [result] = await loginServices(services, deps);

    assert.equal(result.action, "manual");
    assert.ok(result.detail.includes("RESEND_API_KEY"));
  });
});
