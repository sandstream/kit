import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { routeTree } from "../route-inventory.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const CLI = resolve(import.meta.dirname, "..", "cli.js");

function kit(cwd: string, args: string[]) {
  const env = {
    ...process.env,
    KIT_NON_INTERACTIVE: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_BUMBLEBEE: "0",
    KIT_AUDIT_ANCHOR: "0",
    NO_COLOR: "1",
  };
  return spawnSync(process.execPath, [CLI, "security", "routes", ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

describe("kit security routes", () => {
  const app = {
    "server.js":
      'const express = require("express");\nconst app = express();\napp.get("/invoice/:id", h);\n',
  };

  it("prints the inventory with its caveat and exits 0 on a route with no guard seen", () => {
    const dir = routeTree(app);
    try {
      const r = kit(dir, []);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /inventory, not a verdict/);
      assert.match(r.stdout, /GET \/invoice\/:id/);
      assert.match(r.stdout, /auth guard seen: +none seen/);
      assert.match(r.stdout, /Not covered:/);
    } finally {
      rmTemp(dir);
    }
  });

  it("prints JSON with --json and refuses an unknown argument", () => {
    const dir = routeTree(app);
    try {
      const json = JSON.parse(kit(dir, ["--json"]).stdout) as {
        routes: { file: string; line: number }[];
      };
      assert.deepEqual(
        json.routes.map((r) => `${r.file}:${r.line}`),
        ["server.js:3"],
      );
      assert.equal(kit(dir, ["--bogus"]).status, 1);
    } finally {
      rmTemp(dir);
    }
  });
});
