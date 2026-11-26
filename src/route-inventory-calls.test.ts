import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { blankJsComments, callRoutes } from "./route-inventory-calls.js";

const pick = (file: string, text: string) =>
  callRoutes(file, text).map((r) =>
    [r.method, r.path, r.line, r.contextGuards.join("|")].join(" "),
  );

describe("callRoutes: Express", () => {
  const server = [
    'const express = require("express");',
    "const app = express();",
    '// app.get("/commented/:id", h);',
    'app.get("/invoice/:id", (req, res) => res.json({}));',
    "app.use(requireAuth);",
    'app.post("/login", loginLimiter, h);',
    'app.route("/reset").get(show).post(save);',
    'axios.get("/users/:id");',
    'app.get("trust proxy");',
  ].join("\n");

  it("reads verb calls and route chains, skips comments and HTTP clients", () => {
    assert.deepEqual(pick("s.js", server), [
      "GET /invoice/:id 4 ",
      "POST /login 6 use(): requireAuth",
      "GET /reset 7 use(): requireAuth",
      "POST /reset 7 use(): requireAuth",
    ]);
  });

  it("keeps the call's own arguments as the handler text", () => {
    const login = callRoutes("s.js", server).find((r) => r.path === "/login");
    assert.equal(login?.handlerText, '("/login", loginLimiter, h)');
  });

  it("reads nothing from a file that imports no server framework", () => {
    assert.deepEqual(callRoutes("c.js", 'router.get("/admin", h);'), []);
  });

  it("blanks comments but not strings", () => {
    assert.equal(blankJsComments('a("//x") // y\n/* z */b'), 'a("//x")     \n       b');
  });
});

describe("callRoutes: Fastify and Hono", () => {
  it("reads a Fastify route object with a method list", () => {
    const text = [
      'import Fastify from "fastify";',
      "const f = Fastify();",
      'f.route({ method: ["GET", "DELETE"], url: "/files/:fileId", preHandler: [f.authenticate], handler: h });',
    ].join("\n");
    const routes = callRoutes("f.ts", text);
    assert.deepEqual(
      routes.map((r) => `${r.framework} ${r.method} ${r.path}`),
      ["fastify GET /files/:fileId", "fastify DELETE /files/:fileId"],
    );
    assert.match(routes[0].handlerText, /preHandler: \[f\.authenticate\]/);
  });

  it("reads Hono verb calls and the use() before them", () => {
    const text = [
      'import { Hono } from "hono";',
      "const app = new Hono();",
      'app.use("/admin/*", bearerAuth({ token }));',
      'app.get("/admin/users/:id", (c) => c.json({}));',
    ].join("\n");
    assert.deepEqual(pick("h.ts", text), ["GET /admin/users/:id 4 use(): bearerAuth"]);
  });
});
