/** The exposure checks run as one set: client env names, built bundle, anonymous database access. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkExposureSet } from "./check-exposure-set.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-exposure-set-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("checkExposureSet", () => {
  it("returns the three exposure rows in a fixed order", async () => {
    const dir = tree({ "package.json": "{}" });
    try {
      const rows = await checkExposureSet(dir, null);
      assert.equal(rows.length, 3);
      assert.match(rows[2].name, /anonymous database access/);
      assert.ok(rows.every((r) => r.category === "exposure"));
    } finally {
      rmTemp(dir);
    }
  });

  it("includes the anonymous access finding next to the other rows", async () => {
    const dir = tree({
      "supabase/migrations/001.sql":
        "CREATE TABLE content (id int, phone text);\nCREATE POLICY p ON content FOR SELECT USING (true);",
    });
    try {
      const rows = await checkExposureSet(dir, null);
      const anon = rows.find((r) => /anonymous database access/.test(r.name));
      assert.equal(anon?.status, "fail");
    } finally {
      rmTemp(dir);
    }
  });

  it("passes the configured client allow list and declared key names to the name check", async () => {
    const dir = tree({ ".env": "VITE_SECRET_TOKEN=\n" });
    try {
      const without = await checkExposureSet(dir, null);
      const governed = {
        scan: { client_exposed_allow: { VITE_SECRET_TOKEN: "public by design" } },
      } as unknown as Parameters<typeof checkExposureSet>[1];
      const withAllow = await checkExposureSet(dir, governed);
      assert.notEqual(without[0].status, "pass");
      assert.equal(withAllow[0].status, "pass");
    } finally {
      rmTemp(dir);
    }
  });
});
