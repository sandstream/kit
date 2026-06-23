import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServiceConfig } from "./config.js";
import { resolveServiceAuth, resolveAllAuth } from "./service-auth.js";

const svc = (o: Partial<ServiceConfig>): ServiceConfig => o as ServiceConfig;

describe("service auth resolver", () => {
  it("infers interactive when a login command exists", () => {
    const r = resolveServiceAuth("vercel", svc({ login: "vercel login", check: "vercel whoami" }));
    assert.equal(r.strategy, "interactive");
    assert.match(r.instruction, /vercel login/);
  });

  it("infers vault when there is no login command", () => {
    const r = resolveServiceAuth("stripe", svc({ check: "stripe config --list" }));
    assert.equal(r.strategy, "vault");
    assert.equal(r.passkey, false);
    assert.match(r.instruction, /vault/);
  });

  it("honors an explicit auth override over inference", () => {
    const r = resolveServiceAuth(
      "github",
      svc({ login: "gh auth login", check: "gh auth status", auth: "vault" }),
    );
    assert.equal(r.strategy, "vault"); // explicit wins despite a login command
    assert.equal(r.passkey, false); // vault is never a passkey flow
  });

  it("flags passkey for known browser-login services", () => {
    const gh = resolveServiceAuth(
      "github",
      svc({ login: "gh auth login", check: "gh auth status" }),
    );
    assert.equal(gh.strategy, "interactive");
    assert.equal(gh.passkey, true);
    assert.match(gh.instruction, /passkey/);

    const other = resolveServiceAuth("myapi", svc({ login: "myapi login", check: "myapi whoami" }));
    assert.equal(other.passkey, false);
  });

  it("describes the capture strategy as paste-once-to-vault", () => {
    const r = resolveServiceAuth("openai", svc({ login: "", check: "x", auth: "capture" }));
    assert.equal(r.strategy, "capture");
    assert.match(r.instruction, /kit secrets set/);
    assert.match(r.instruction, /paste once/);
  });

  it("resolveAllAuth returns one plan per service, sorted by name", () => {
    const plans = resolveAllAuth({
      vercel: svc({ login: "vercel login", check: "x" }),
      github: svc({ login: "gh auth login", check: "x" }),
    });
    assert.deepEqual(
      plans.map((p) => p.name),
      ["github", "vercel"],
    );
  });
});
