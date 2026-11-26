import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aiSdkImports, guardsIn, limitersIn, pathClasses } from "./route-inventory-signals.js";
import { sdkLine } from "./route-inventory.test-support.js";

const GEN = ["@google", "generative-ai"].join("/");

describe("route inventory signals", () => {
  it("classes a path by id parameter, admin and auth flow", () => {
    assert.deepEqual(pathClasses("/invoice/:id"), ["id-param"]);
    assert.deepEqual(pathClasses("/users/:userId/notes/:note_id"), ["id-param"]);
    assert.deepEqual(pathClasses("/api/items/[id]"), ["id-param"]);
    assert.deepEqual(pathClasses("/docs/[...docId]"), ["id-param"]);
    assert.deepEqual(pathClasses("/admin/users/:id"), ["id-param", "admin"]);
    assert.deepEqual(pathClasses("/reset-password"), ["auth-flow"]);
    for (const p of ["/login", "/api/signin", "/sign-up", "/register", "/forgot-password"]) {
      assert.deepEqual(pathClasses(p), ["auth-flow"], p);
    }
    assert.deepEqual(pathClasses("/paid/:slug"), []);
    assert.deepEqual(pathClasses("/badminton"), []);
  });

  it("finds AI SDK imports by package and scope, and nothing else", () => {
    const text = [
      sdkLine("openai", "OpenAI"),
      sdkLine("@anthropic-ai/sdk"),
      sdkLine("ai/rsc"),
      sdkLine("@ai-sdk/openai"),
      sdkLine("aight"),
      ["const m = req", "uire(", JSON.stringify(GEN), ");"].join(""),
    ].join("\n");
    assert.deepEqual(aiSdkImports(text), [
      "openai",
      "@anthropic-ai/sdk",
      "ai/rsc",
      "@ai-sdk/openai",
      "@google/generative-ai",
    ]);
  });

  it("names the guard and limiter it saw", () => {
    assert.deepEqual(guardsIn("app.get('/a', requireAuth, h)"), ["requireAuth"]);
    assert.deepEqual(guardsIn("const s = await getServerSession(opts)"), ["session call"]);
    assert.deepEqual(guardsIn("passport.authenticate('jwt')"), ["passport.authenticate"]);
    assert.deepEqual(guardsIn("if (!locals.user) throw error(401)"), [
      "locals.user / locals.session",
    ]);
    assert.deepEqual(guardsIn("(req, res) => res.json(db.all())"), []);
    assert.deepEqual(limitersIn("app.post('/login', loginLimiter, h)"), ["loginLimiter"]);
    assert.deepEqual(limitersIn("{ config: { rateLimit: { max: 5 } } }"), [
      "fastify rateLimit config",
    ]);
    assert.deepEqual(limitersIn("(req, res) => res.json({})"), []);
  });
});
