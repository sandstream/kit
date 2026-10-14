import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authProbeFor, probeAuth } from "./tool-auth.js";

describe("authProbeFor", () => {
  it("prefers the project's own service check when it runs the same binary", () => {
    const services = {
      infisical: { login: "infisical login", check: "infisical login status --json --silent" },
    };
    assert.deepEqual(authProbeFor("infisical", services), {
      command: "infisical login status --json --silent",
      via: "service",
    });
  });

  it("falls back to a built-in probe for well-known CLIs", () => {
    assert.deepEqual(authProbeFor("gh", {}), { command: "gh auth status", via: "builtin" });
  });

  it("has no probe rather than a guess for tools without a safe one", () => {
    assert.equal(authProbeFor("jq", {}), null);
    assert.equal(authProbeFor("gcloud", {}), null);
  });

  it("ignores informational service checks and checks for other binaries", () => {
    const services = {
      resend: { login: "", check: "# resend - check RESEND_API_KEY is set" },
      deploy: { login: "", check: "vercel whoami" },
    };
    assert.equal(authProbeFor("resend", services), null);
    assert.deepEqual(authProbeFor("gh", services), { command: "gh auth status", via: "builtin" });
  });
});

describe("probeAuth", () => {
  it("reports only the status, never the probe's output", async () => {
    const result = await probeAuth({ command: "gh auth status", via: "builtin" }, async () => ({
      authenticated: true,
      output: "Logged in as someone with token gho_x",
    }));
    assert.deepEqual(result, {
      status: "authenticated",
      via: "builtin",
      command: "gh auth status",
    });
  });

  it("a failed probe is unauthenticated", async () => {
    const result = await probeAuth({ command: "op whoami", via: "builtin" }, async () => ({
      authenticated: false,
      output: "not signed in",
    }));
    assert.equal(result.status, "unauthenticated");
  });
});
