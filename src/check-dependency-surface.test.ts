import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDependencySurface } from "./check-dependency-surface.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NAME = "dependency surface";

function project(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-check-surface-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const lock = (extra: Record<string, object> = {}) => ({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/used": { version: "1.0.0" },
    "node_modules/idle": { version: "1.0.0" },
    ...extra,
  },
});

describe("checkDependencySurface", () => {
  it("says nothing for a folder that is not an npm project", async () => {
    const dir = project({ "README.md": "hello" });
    try {
      assert.deepEqual(await checkDependencySurface(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports the numbers in one row, and a suggestion row per finding, none of which fail", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "1.0.0", idle: "1.0.0" } },
      "package-lock.json": lock(),
      "src/a.js": 'import u from "used";\n',
    });
    try {
      const rows = await checkDependencySurface(dir);
      const summary = rows.find((r) => r.name === NAME);
      assert.ok(summary);
      assert.equal(summary.status, "pass");
      assert.equal(summary.category, "dependency");
      assert.match(summary.detail, /2 direct \(2 prod, 0 dev\)/);
      assert.match(summary.detail, /2 packages/);
      const idle = rows.find((r) => r.name === `${NAME}: unused`);
      assert.ok(idle, "idle is declared and never imported");
      assert.match(idle.detail, /idle/);
      assert.ok(idle.suggestion);
      for (const r of rows) assert.ok(r.status === "pass", `${r.name} must not move the verdict`);
    } finally {
      rmTemp(dir);
    }
  });

  it("says what it cannot see, so a missing finding is not read as a clean one", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "1.0.0" } },
      "package-lock.json": lock(),
      "src/a.js": 'import u from "used";\n',
    });
    try {
      const summary = (await checkDependencySurface(dir)).find((r) => r.name === NAME);
      assert.match(summary?.detail ?? "", /dynamic imports/);
      assert.match(summary?.detail ?? "", /by convention/);
    } finally {
      rmTemp(dir);
    }
  });

  it("skips honestly for a yarn or pnpm project, naming the lockfile it did not read", async () => {
    for (const file of ["yarn.lock", "pnpm-lock.yaml"]) {
      const dir = project({ "package.json": { dependencies: { used: "1.0.0" } }, [file]: "" });
      try {
        const rows = await checkDependencySurface(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "skip");
        assert.match(rows[0].detail, new RegExp(file.replace(".", "\\.")));
      } finally {
        rmTemp(dir);
      }
    }
  });
});

describe("checkDependencySurface skips", () => {
  it("skips for a lockfile without a package list, and for an unreadable manifest", async () => {
    const old = project({
      "package.json": { dependencies: { used: "1.0.0" } },
      "package-lock.json": { lockfileVersion: 1, dependencies: {} },
    });
    const broken = project({ "package.json": "{not json", "package-lock.json": lock() });
    try {
      for (const dir of [old, broken]) {
        const rows = await checkDependencySurface(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "skip");
      }
    } finally {
      rmTemp(old);
      rmTemp(broken);
    }
  });
});

describe("checkDependencySurface rows", () => {
  it("gives one row per rule, however many packages it names, heaviest first", async () => {
    const packages: Record<string, object> = { "": {} };
    const deps: Record<string, string> = {};
    for (const [name, n] of [
      ["a-dep", 16],
      ["b-dep", 40],
    ] as const) {
      const own = Array.from({ length: n }, (_, i) => `${name}-leaf-${i}`);
      packages[`node_modules/${name}`] = {
        version: "1.0.0",
        dependencies: Object.fromEntries(own.map((l) => [l, "^1"])),
      };
      for (const l of own) packages[`node_modules/${l}`] = { version: "1.0.0" };
      deps[name] = "1.0.0";
    }
    packages["node_modules/idle-1"] = { version: "1.0.0" };
    packages["node_modules/idle-2"] = { version: "1.0.0" };
    deps["idle-1"] = "1.0.0";
    deps["idle-2"] = "1.0.0";
    const dir = project({
      "package.json": { dependencies: deps },
      "package-lock.json": { lockfileVersion: 3, packages },
    });
    try {
      const rows = await checkDependencySurface(dir);
      const heavy = rows.filter((r) => r.name === `${NAME}: heavy`);
      const unused = rows.filter((r) => r.name === `${NAME}: unused`);
      assert.equal(heavy.length, 1);
      assert.equal(unused.length, 1);
      assert.ok(
        heavy[0].detail.indexOf("b-dep") < heavy[0].detail.indexOf("a-dep"),
        "heaviest first",
      );
      assert.match(unused[0].detail, /idle-1/);
      assert.match(unused[0].detail, /idle-2/);
    } finally {
      rmTemp(dir);
    }
  });

  it("lists at most five names per row and says how many more there are", async () => {
    const packages: Record<string, object> = { "": {} };
    const deps: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      packages[`node_modules/idle-${i}`] = { version: "1.0.0" };
      deps[`idle-${i}`] = "1.0.0";
    }
    const dir = project({
      "package.json": { dependencies: deps },
      "package-lock.json": { lockfileVersion: 3, packages },
    });
    try {
      const unused = (await checkDependencySurface(dir)).find((r) => r.name === `${NAME}: unused`);
      assert.match(unused?.detail ?? "", /\+3 more/);
    } finally {
      rmTemp(dir);
    }
  });
});
