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

  it("skips honestly for a bun project, naming the lockfile it did not read", async () => {
    for (const file of ["bun.lock", "bun.lockb"]) {
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

describe("checkDependencySurface with yarn.lock", () => {
  const YARN = `# yarn lockfile v1


idle@^1.0.0:
  version "1.0.0"

used@^1.0.0:
  version "1.0.0"
  dependencies:
    shared "^1.0.0"

shared@^1.0.0:
  version "1.0.0"
`;

  it("measures a yarn project and says what yarn.lock cannot tell it", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0", idle: "^1.0.0" } },
      "yarn.lock": YARN,
      "src/a.js": 'import u from "used";\n',
    });
    try {
      const rows = await checkDependencySurface(dir);
      const summary = rows.find((r) => r.name === NAME);
      assert.ok(summary);
      assert.equal(summary.status, "pass");
      assert.match(summary.detail, /2 direct \(2 prod, 0 dev\)/);
      assert.match(summary.detail, /3 packages/);
      assert.match(summary.detail, /yarn\.lock/);
      assert.match(summary.detail, /engines and install scripts/);
      const unused = rows.find((r) => r.name === `${NAME}: unused`);
      assert.match(unused?.detail ?? "", /idle/);
      for (const r of rows) assert.equal(r.status, "pass", `${r.name} must not move the verdict`);
    } finally {
      rmTemp(dir);
    }
  });
});

const PNPM = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      idle:
        specifier: ^1.0.0
        version: 1.0.0
      used:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  idle@1.0.0:
    resolution: {integrity: sha512-a}

  shared@1.0.0:
    resolution: {integrity: sha512-b}
    engines: {node: '>=18'}

  used@1.0.0:
    resolution: {integrity: sha512-c}

snapshots:

  idle@1.0.0: {}

  shared@1.0.0: {}

  used@1.0.0:
    dependencies:
      shared: 1.0.0
`;

describe("checkDependencySurface with pnpm-lock.yaml", () => {
  it("measures a pnpm project and says what pnpm-lock.yaml cannot tell it", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0", idle: "^1.0.0" } },
      "pnpm-lock.yaml": PNPM,
      "src/a.js": 'import u from "used";\n',
    });
    try {
      const rows = await checkDependencySurface(dir);
      const summary = rows.find((r) => r.name === NAME);
      assert.ok(summary);
      assert.equal(summary.status, "pass");
      assert.match(summary.detail, /2 direct \(2 prod, 0 dev\)/);
      assert.match(summary.detail, /3 packages in pnpm-lock\.yaml/);
      assert.match(summary.detail, /bin names/);
      assert.doesNotMatch(summary.detail, /engines and install scripts/);
      const unused = rows.find((r) => r.name === `${NAME}: unused`);
      assert.match(unused?.detail ?? "", /idle/);
      for (const r of rows) assert.equal(r.status, "pass", `${r.name} must not move the verdict`);
    } finally {
      rmTemp(dir);
    }
  });

  it("skips, naming pnpm-lock.yaml, when the file is not a pnpm lockfile", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0" } },
      "pnpm-lock.yaml": "something else entirely\n",
    });
    try {
      const rows = await checkDependencySurface(dir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "skip");
      assert.match(rows[0].detail, /pnpm-lock\.yaml/);
    } finally {
      rmTemp(dir);
    }
  });

  it("skips, naming the format, for a lockfile of another format than 9", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0" } },
      "pnpm-lock.yaml": PNPM.replace("'9.0'", "'6.0'"),
    });
    try {
      const rows = await checkDependencySurface(dir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "skip");
      assert.match(rows[0].detail, /pnpm-lock\.yaml/);
      assert.match(rows[0].detail, /6\.0/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkDependencySurface with yarn.lock, unreadable and mixed", () => {
  const YARN = `# yarn lockfile v1\n\nidle@^1.0.0:\n  version "1.0.0"\n\nused@^1.0.0:\n  version "1.0.0"\n  dependencies:\n    shared "^1.0.0"\n\nshared@^1.0.0:\n  version "1.0.0"\n`;

  it("skips, naming yarn.lock, when the file is neither the classic nor the berry format", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0" } },
      "yarn.lock": "something else entirely\n",
    });
    try {
      const rows = await checkDependencySurface(dir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "skip");
      assert.match(rows[0].detail, /yarn\.lock/);
    } finally {
      rmTemp(dir);
    }
  });

  it("prefers package-lock.json when a project has both", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "1.0.0" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/used": { version: "1.0.0" } },
      },
      "yarn.lock": YARN,
      "src/a.js": 'import u from "used";\n',
    });
    try {
      const summary = (await checkDependencySurface(dir)).find((r) => r.name === NAME);
      assert.match(
        summary?.detail ?? "",
        /1 packages? in package-lock\.json|1 packages? in the lockfile/,
      );
      assert.doesNotMatch(summary?.detail ?? "", /yarn\.lock/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkDependencySurface when package.json and the lockfile disagree", () => {
  const YARN = `# yarn lockfile v1


used@^1.0.0:
  version "1.0.0"
`;

  it("refuses to measure when most direct dependencies are missing from the lockfile", async () => {
    const dir = project({
      "package.json": {
        dependencies: { used: "^1.0.0", a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" },
      },
      "yarn.lock": YARN,
    });
    try {
      const rows = await checkDependencySurface(dir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "skip");
      assert.match(rows[0].detail, /3 of 4 direct dependencies/);
      assert.match(rows[0].detail, /out of date|another project/);
      assert.match(rows[0].detail, /\ba\b/);
    } finally {
      rmTemp(dir);
    }
  });

  it("measures, and names the one it could not find, when only a minority is missing", async () => {
    const lock = `# yarn lockfile v1\n\nused@^1.0.0:\n  version "1.0.0"\n\nmore@^1.0.0:\n  version "1.0.0"\n\nthird@^1.0.0:\n  version "1.0.0"\n\nfourth@^1.0.0:\n  version "1.0.0"\n`;
    const dir = project({
      "package.json": {
        dependencies: {
          used: "^1.0.0",
          more: "^1.0.0",
          third: "^1.0.0",
          fourth: "^1.0.0",
          odd: "workspace:*",
        },
      },
      "yarn.lock": lock,
    });
    try {
      const summary = (await checkDependencySurface(dir)).find((r) => r.name === NAME);
      assert.ok(summary);
      assert.match(summary.detail, /Not found in yarn\.lock: odd/);
    } finally {
      rmTemp(dir);
    }
  });

  it("says when the project is a workspace root, whose packages are not counted as direct", async () => {
    const dir = project({
      "package.json": { workspaces: ["packages/*"], devDependencies: { used: "^1.0.0" } },
      "yarn.lock": YARN,
    });
    try {
      const summary = (await checkDependencySurface(dir)).find((r) => r.name === NAME);
      assert.match(summary?.detail ?? "", /workspace root/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkDependencySurface in a workspace", () => {
  const ROOT_LOCK = `# yarn lockfile v1


used@^1.0.0:
  version "1.0.0"
  dependencies:
    shared "^1.0.0"

shared@^1.0.0:
  version "1.0.0"

other-member-only@^2.0.0:
  version "2.0.0"
`;
  const STALE_LOCK = `# yarn lockfile v1\n\nold@^1.0.0:\n  version "1.0.0"\n`;

  it("reads the workspace root's lockfile when the member has none, and counts only what it reaches", async () => {
    const dir = project({
      "package.json": { workspaces: ["packages/*"] },
      "yarn.lock": ROOT_LOCK,
      "packages/app/package.json": { dependencies: { used: "^1.0.0" } },
      "packages/app/src/a.js": 'import u from "used";\n',
    });
    try {
      const rows = await checkDependencySurface(join(dir, "packages", "app"));
      const summary = rows.find((r) => r.name === NAME);
      assert.ok(summary);
      assert.match(summary.detail, /2 packages in \.\.\/\.\.\/yarn\.lock/);
      assert.doesNotMatch(summary.detail, /other-member-only/);
    } finally {
      rmTemp(dir);
    }
  });

  it("falls back to the workspace root when the member's own lockfile is stale", async () => {
    const dir = project({
      "package.json": { workspaces: ["packages/*"] },
      "yarn.lock": ROOT_LOCK,
      "packages/app/package.json": {
        dependencies: { used: "^1.0.0", shared: "^1.0.0", more: "^1.0.0" },
      },
      "packages/app/yarn.lock": STALE_LOCK,
    });
    try {
      const rows = await checkDependencySurface(join(dir, "packages", "app"));
      assert.equal(rows[0].status, "pass");
      assert.match(rows[0].detail, /in \.\.\/\.\.\/yarn\.lock/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkDependencySurface in a workspace, which lockfile counts", () => {
  const ROOT_LOCK = `# yarn lockfile v1\n\nused@^1.0.0:\n  version "1.0.0"\n  dependencies:\n    shared "^1.0.0"\n\nshared@^1.0.0:\n  version "1.0.0"\n`;

  it("does not borrow the lockfile of a parent folder that is not a workspace root", async () => {
    const dir = project({
      "package.json": { dependencies: { used: "^1.0.0" } },
      "yarn.lock": ROOT_LOCK,
      "packages/app/package.json": { dependencies: { used: "^1.0.0" } },
    });
    try {
      assert.deepEqual(await checkDependencySurface(join(dir, "packages", "app")), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("recognises a lerna root as a workspace root", async () => {
    const dir = project({
      "package.json": { devDependencies: { lerna: "^4.0.0" } },
      "lerna.json": { version: "independent" },
      "yarn.lock": ROOT_LOCK,
      "packages/app/package.json": { dependencies: { used: "^1.0.0" } },
    });
    try {
      const summary = (await checkDependencySurface(join(dir, "packages", "app"))).find(
        (r) => r.name === NAME,
      );
      assert.match(summary?.detail ?? "", /\.\.\/\.\.\/yarn\.lock/);
    } finally {
      rmTemp(dir);
    }
  });
});
