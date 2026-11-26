import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { exportedVerbs, fileRoute, guardFileCandidates } from "./route-inventory-files.js";

const NEXT = { next: true, sveltekit: false };
const SVK = { next: false, sveltekit: true };
const at = (file: string, text = "", fw = NEXT) => {
  const r = fileRoute(file, text, fw);
  return r ? `${r.framework} ${r.methods.join(",")} ${r.path}` : null;
};

describe("fileRoute", () => {
  it("reads exported verbs by declaration and export list", () => {
    const text =
      "export async function GET() {}\nexport const POST = h;\nexport { del as DELETE };";
    assert.deepEqual(exportedVerbs(text), ["GET", "POST", "DELETE"]);
  });

  it("maps Next.js app router files, dropping groups and slots", () => {
    assert.equal(
      at("web/app/api/items/[id]/route.ts", "export function GET() {}"),
      "next-app GET /api/items/[id]",
    );
    assert.equal(at("app/(auth)/login/page.tsx"), "next-app PAGE /login");
    assert.equal(at("src/app/@modal/admin/page.jsx"), "next-app PAGE /admin");
    assert.equal(at("app/_lib/admin/page.tsx"), null);
    assert.equal(at("app/admin/layout.tsx"), null);
  });

  it("maps Next.js pages router files", () => {
    assert.equal(at("pages/api/users/[userId].ts"), "next-pages ANY /api/users/[userId]");
    assert.equal(at("src/pages/admin/index.tsx"), "next-pages PAGE /admin");
    assert.equal(at("pages/_app.tsx"), null);
  });

  it("maps SvelteKit routes and needs the framework declared", () => {
    assert.equal(
      at("src/routes/api/[id]/+server.ts", "export const GET = h;", SVK),
      "sveltekit GET /api/[id]",
    );
    assert.equal(at("src/routes/(app)/admin/+page.svelte", "", SVK), "sveltekit PAGE /admin");
    assert.equal(at("src/routes/admin/+page.svelte", "", NEXT), null);
    assert.equal(at("app/admin/page.tsx", "", { next: false, sveltekit: false }), null);
  });

  it("lists the files around a route that may guard it", () => {
    const r = fileRoute("web/app/admin/page.tsx", "", NEXT);
    assert.ok(r);
    const files = guardFileCandidates(r).map((c) => `${c.label} ${c.file}`);
    assert.ok(files.includes("middleware web/middleware.ts"));
    assert.ok(files.includes("layout web/app/layout.tsx"));
    assert.ok(files.includes("layout web/app/admin/layout.tsx"));
  });
});
