import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  createEntraProvider,
  createEntraApiSource,
  createGoogleProvider,
  createGoogleApiSource,
} from "./providers-cloud.js";
import { compileRoleBindings } from "./identity-provider.js";

/* ------------------------------------------------------------------ Entra ID */

describe("rbac/providers-cloud — Entra (Microsoft Graph) source, fake fetch", () => {
  const prev = process.env.KIT_RBAC_ENTRA_API;
  after(() => {
    if (prev === undefined) delete process.env.KIT_RBAC_ENTRA_API;
    else process.env.KIT_RBAC_ENTRA_API = prev;
  });

  it("parses memberOf, follows nextLink, keeps only groups, honors KIT_RBAC_ENTRA_API + bearer", async () => {
    process.env.KIT_RBAC_ENTRA_API = "https://graph.example.com";
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      const u = String(url);
      if (u.includes("/memberOf") && !u.includes("$skiptoken")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              { "@odata.type": "#microsoft.graph.group", displayName: "deployers" },
              { "@odata.type": "#microsoft.graph.directoryRole", displayName: "Global Admin" },
            ],
            "@odata.nextLink": "https://graph.example.com/v1.0/x?$skiptoken=abc",
          }),
        };
      }
      // page 2 (nextLink)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [{ "@odata.type": "#microsoft.graph.group", id: "gid-2" }],
        }),
      };
    }) as unknown as typeof fetch;

    const src = createEntraApiSource({ token: "aad-token", fetchImpl: fakeFetch });
    const groups = await src.listGroups("octo@contoso.com");
    // group displayName from p1 + id fallback from p2; the directoryRole is dropped
    assert.deepEqual(groups, ["deployers", "gid-2"]);
    assert.ok(seen[0].url.startsWith("https://graph.example.com/v1.0/users/"));
    assert.equal(seen[0].auth, "Bearer aad-token");
    assert.equal(seen.length, 2, "followed nextLink");
  });

  it("fail-closed: a non-OK response THROWS", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const src = createEntraApiSource({ token: "t", fetchImpl: fakeFetch });
    await assert.rejects(() => src.listGroups("x@y.com"), /Entra memberOf failed.*HTTP 401/);
  });

  it("provider namespaces by tenant and compiles bindings offline (zero fetch)", async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    createEntraApiSource({ token: "x", fetchImpl: fakeFetch }); // built but unused
    const provider = createEntraProvider({
      tenant: "contoso",
      source: {
        async listGroups() {
          return ["deployers"];
        },
      },
    });
    const result = await compileRoleBindings({
      provider,
      roleMap: { "contoso/deployers": "deployer" },
      subjects: [{ subject: "eve@contoso.com", kid: "kid_eve" }],
    });
    assert.deepEqual(result.bindings, [{ kid: "kid_eve", role: "deployer" }]);
    assert.equal(fetchCalls, 0);
  });
});

/* --------------------------------------------------------------- Google Cloud */

describe("rbac/providers-cloud — Google Cloud Identity source, fake fetch", () => {
  const prev = process.env.KIT_RBAC_GOOGLE_API;
  after(() => {
    if (prev === undefined) delete process.env.KIT_RBAC_GOOGLE_API;
    else process.env.KIT_RBAC_GOOGLE_API = prev;
  });

  it("parses searchTransitiveGroups, follows nextPageToken, honors base URL + bearer", async () => {
    process.env.KIT_RBAC_GOOGLE_API = "https://ci.example.com";
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(String(url));
      assert.equal(init.headers.Authorization, "Bearer gcp-token");
      if (!String(url).includes("pageToken")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            memberships: [{ groupKey: { id: "deployers@example.com" } }],
            nextPageToken: "tok2",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ memberships: [{ groupKey: { id: "viewers@example.com" } }] }),
      };
    }) as unknown as typeof fetch;

    const src = createGoogleApiSource({ token: "gcp-token", fetchImpl: fakeFetch });
    const groups = await src.listGroups("eve@example.com");
    assert.deepEqual(groups, ["deployers@example.com", "viewers@example.com"]);
    assert.ok(
      seen[0].startsWith("https://ci.example.com/v1/groups/-/memberships:searchTransitiveGroups"),
    );
    assert.ok(seen[0].includes("member_key_id"));
    assert.equal(seen.length, 2, "followed nextPageToken");
  });

  it("fail-closed: a non-OK response THROWS", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const src = createGoogleApiSource({ token: "t", fetchImpl: fakeFetch });
    await assert.rejects(
      () => src.listGroups("x@y.com"),
      /Google Cloud Identity search failed.*HTTP 403/,
    );
  });

  it("provider compiles bindings offline (zero fetch)", async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    createGoogleApiSource({ token: "x", fetchImpl: fakeFetch });
    const provider = createGoogleProvider({
      source: {
        async listGroups() {
          return ["deployers@example.com"];
        },
      },
    });
    const result = await compileRoleBindings({
      provider,
      roleMap: { "deployers@example.com": "deployer" },
      subjects: [{ subject: "eve@example.com", kid: "kid_eve" }],
    });
    assert.deepEqual(result.bindings, [{ kid: "kid_eve", role: "deployer" }]);
    assert.equal(fetchCalls, 0);
  });
});
