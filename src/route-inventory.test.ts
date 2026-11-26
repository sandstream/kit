import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRouteInventory } from "./route-inventory.js";
import { routeTree, sdkLine } from "./route-inventory.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function inventory(spec: Record<string, string>) {
  const dir = routeTree(spec);
  try {
    return buildRouteInventory(dir);
  } finally {
    rmTemp(dir);
  }
}

const row = (r: {
  method: string;
  path: string;
  classes: string[];
  authGuardSeen: string[];
  rateLimiterSeen: string[];
}) =>
  `${r.method} ${r.path} [${r.classes.join(",")}] guard=${r.authGuardSeen.join("|")} limiter=${r.rateLimiterSeen.join("|")}`;

describe("buildRouteInventory", () => {
  it("lists the sensitive routes of an Express app with both columns empty when nothing is seen", () => {
    const inv = inventory({
      "src/server.js": [
        'const express = require("express");',
        "const app = express();",
        'app.get("/invoice/:id", (req, res) => res.json({}));',
        'app.get("/admin", (req, res) => res.send("ok"));',
        'app.post("/login", h);',
        'app.get("/health", (req, res) => res.send("ok"));',
      ].join("\n"),
    });
    assert.deepEqual(inv.routes.map(row), [
      "GET /invoice/:id [id-param] guard= limiter=",
      "GET /admin [admin] guard= limiter=",
      "POST /login [auth-flow] guard= limiter=",
    ]);
    assert.equal(inv.totalRoutes, 4);
    assert.match(inv.note, /not decided statically/);
  });

  it("lists an AI route by its file's imports and reads Next.js middleware and layouts", () => {
    const inv = inventory({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
      "app/api/chat/route.ts": `${sdkLine("ai")}\nexport async function POST() { await ratelimit.limit(ip); }`,
      "app/admin/layout.tsx":
        "export default async function L() { const s = await getServerSession(); }",
      "app/admin/page.tsx": "export default function P() { return null; }",
      "middleware.ts": "export default clerkMiddleware();",
    });
    assert.deepEqual(inv.routes.map(row), [
      "PAGE /admin [admin] guard=middleware: clerkMiddleware (coverage not read)|layout: session call limiter=",
      "POST /api/chat [ai] guard=middleware: clerkMiddleware (coverage not read) limiter=ratelimit",
    ]);
    assert.deepEqual(inv.routes[1].aiSdks, ["ai"]);
  });

  it("reads SvelteKit form actions and ignores file routes when the framework is not declared", () => {
    const svk = inventory({
      "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "2.0.0" } }),
      "src/routes/login/+page.svelte": "<form method=post></form>",
      "src/routes/login/+page.server.ts": "export const actions = { default: async () => {} };",
    });
    assert.deepEqual(
      svk.routes.map((r) => `${r.method} ${r.path}`),
      ["ACTIONS /login", "PAGE /login"],
    );
    const none = inventory({ "app/admin/page.tsx": "", "src/routes/admin/+page.svelte": "" });
    assert.equal(none.totalRoutes, 0);
  });
});

it("reports files that cannot be read within the route inventory limits", () => {
  const inv = inventory({
    "package.json/not-a-config": "",
    "app/admin/page.tsx": "",
    "src/oversized.ts": " ".repeat(1024 * 1024 + 1),
  });
  assert.deepEqual(inv.notRead.sort(), ["package.json", "src/oversized.ts"]);
});
