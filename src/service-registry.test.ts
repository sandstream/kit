import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectServices, SERVICE_BY_ID, SERVICE_REGISTRY } from "./service-registry.js";

const noFiles = async () => false;

describe("service-registry", () => {
  describe("detectServices — node deps", () => {
    it("matches a service by an exact dependency", async () => {
      const s = await detectServices({ deps: ["stripe"], fileExists: noFiles });
      assert.deepEqual(s, ["stripe"]);
    });

    it("matches a new service (convex) by dep", async () => {
      const s = await detectServices({ deps: ["convex"], fileExists: noFiles });
      assert.deepEqual(s, ["convex"]);
    });

    it("matches mysql via the mysql2 driver", async () => {
      const s = await detectServices({ deps: ["mysql2"], fileExists: noFiles });
      assert.deepEqual(s, ["mysql"]);
    });

    it("returns services in registry order regardless of input order (stripe precedes supabase)", async () => {
      const s = await detectServices({ deps: ["@supabase/supabase-js", "stripe"], fileExists: noFiles });
      assert.deepEqual(s, ["stripe", "supabase"]);
    });
  });

  describe("detectServices — marker files", () => {
    it("matches supabase by its directory", async () => {
      const s = await detectServices({ deps: [], fileExists: async (p) => p === "supabase" });
      assert.deepEqual(s, ["supabase"]);
    });

    it("matches firebase by firebase.json", async () => {
      const s = await detectServices({ deps: [], fileExists: async (p) => p === "firebase.json" });
      assert.deepEqual(s, ["firebase"]);
    });

    it("matches atlassian by bitbucket-pipelines.yml", async () => {
      const s = await detectServices({ deps: [], fileExists: async (p) => p === "bitbucket-pipelines.yml" });
      assert.deepEqual(s, ["atlassian"]);
    });
  });

  describe("new services — keycloak + atlassian", () => {
    it("detects keycloak by a node client dep", async () => {
      const s = await detectServices({ deps: ["keycloak-js"], fileExists: noFiles });
      assert.deepEqual(s, ["keycloak"]);
    });

    it("detects keycloak by the python client", async () => {
      const s = await detectServices({ pyText: "python-keycloak==3.9.1", fileExists: noFiles });
      assert.deepEqual(s, ["keycloak"]);
    });

    it("keycloak declares admin/realm secrets and no mise tool (it is a server)", () => {
      const kc = SERVICE_BY_ID["keycloak"];
      assert.ok(kc.secrets?.includes("KEYCLOAK_CLIENT_SECRET"));
      assert.ok(kc.secrets?.includes("KEYCLOAK_REALM"));
      assert.equal(kc.tool, undefined);
    });

    it("atlassian provisions the acli CLI as its mise tool", () => {
      assert.equal(SERVICE_BY_ID["atlassian"].tool, "acli");
      assert.ok(SERVICE_BY_ID["atlassian"].secrets?.includes("ATLASSIAN_API_TOKEN"));
    });
  });

  describe("detectServices — cross-language (the Node-only gap fix)", () => {
    it("detects services from Python requirements text", async () => {
      const s = await detectServices({
        pyText: "fastapi==0.110\nstripe==8.0.0\nsentry-sdk[fastapi]==1.40\n",
        fileExists: noFiles,
      });
      assert.ok(s.includes("stripe"), "stripe from py dep");
      assert.ok(s.includes("sentry"), "sentry from sentry-sdk");
    });

    it("detects services from a Go module file", async () => {
      const s = await detectServices({
        goMod: "module x\nrequire github.com/stripe/stripe-go/v76 v76.0.0\n",
        fileExists: noFiles,
      });
      assert.deepEqual(s, ["stripe"]);
    });

    it("returns nothing for an unknown stack", async () => {
      assert.deepEqual(await detectServices({ deps: ["lodash"], fileExists: noFiles }), []);
    });
  });

  describe("SERVICE_BY_ID + registry shape", () => {
    it("exposes secret keys for the generator", () => {
      assert.ok(SERVICE_BY_ID.stripe.secrets?.includes("STRIPE_SECRET_KEY"));
      assert.equal(SERVICE_BY_ID.supabase.tool, "supabase");
      assert.equal(SERVICE_BY_ID.supabase.migrate, "supabase db push");
    });

    it("ORM-only entries (prisma/drizzle) declare migrate but no login (no [services.X] block)", () => {
      assert.equal(SERVICE_BY_ID.prisma.migrate, "npx prisma migrate deploy");
      assert.equal(SERVICE_BY_ID.prisma.login, undefined);
      assert.equal(SERVICE_BY_ID.drizzle.login, undefined);
    });

    it("every registry entry has a unique id", () => {
      const ids = SERVICE_REGISTRY.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, "duplicate service id");
    });

    it("the new DB/BaaS services are present", () => {
      for (const id of [
        "convex", "firebase", "mysql", "planetscale", "neon", "turso", "bigquery", "snowflake",
        "redshift", "redis", "auth0",
      ]) {
        assert.ok(SERVICE_BY_ID[id], `missing new service: ${id}`);
      }
    });
  });
});
