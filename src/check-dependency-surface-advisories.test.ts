import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisoryOptionsFor, checkDependencySurface } from "./check-dependency-surface.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NAME = "dependency surface";

function project(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-check-advisories-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const lock = () => ({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/used": { version: "1.0.0" },
    "node_modules/idle": { version: "1.0.0" },
  },
});

const ADV = `${NAME}: advisories`;

describe("checkDependencySurface advisories", () => {
  const dir = () =>
    project({
      "package.json": { dependencies: { used: "1.0.0", idle: "1.0.0" } },
      "package-lock.json": lock(),
      "src/a.js": 'import u from "used";\n',
    });

  it("asks for the lockfile's packages and adds one row naming the dependencies that bring advisories", async () => {
    const d = dir();
    try {
      const asked: string[] = [];
      const rows = await checkDependencySurface(d, {
        advisories: async (pkgs) => {
          asked.push(...pkgs.map((p) => `${p.name}@${p.version}`));
          return {
            found: new Map([["used@1.0.0", ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]]]),
            checked: true,
          };
        },
      });
      assert.deepEqual(asked.sort(), ["idle@1.0.0", "used@1.0.0"]);
      const row = rows.find((r) => r.name === ADV);
      assert.ok(row);
      assert.equal(row.status, "pass", "advisory only: never moves the verdict");
      assert.match(row.detail, /2 known advisories/);
      assert.match(row.detail, /used \(2\)/);
      assert.ok(row.suggestion);
    } finally {
      rmTemp(d);
    }
  });

  it("adds no row when nothing is known, and none when no lookup is given", async () => {
    const d = dir();
    try {
      const none = await checkDependencySurface(d, {
        advisories: async () => ({ found: new Map(), checked: true }),
      });
      assert.equal(
        none.some((r) => r.name === ADV),
        false,
      );
      const off = await checkDependencySurface(d);
      assert.equal(
        off.some((r) => r.name === ADV),
        false,
      );
    } finally {
      rmTemp(d);
    }
  });
});

describe("checkDependencySurface advisories that did not finish", () => {
  const dir = () =>
    project({
      "package.json": { dependencies: { used: "1.0.0", idle: "1.0.0" } },
      "package-lock.json": lock(),
      "src/a.js": 'import u from "used";\n',
    });

  it("says plainly when the lookup could not finish, so no row reads as clean", async () => {
    const d = dir();
    try {
      const rows = await checkDependencySurface(d, {
        advisories: async () => ({
          found: new Map(),
          checked: false,
          note: "air gap: 2 package(s) have no cached advisory answer, and nothing is fetched",
        }),
      });
      const row = rows.find((r) => r.name === ADV);
      assert.ok(row);
      assert.equal(row.status, "skip");
      assert.match(row.detail, /not checked/i);
      assert.match(row.detail, /air gap/);
    } finally {
      rmTemp(d);
    }
  });

  it("keeps the surface rows when the lookup throws", async () => {
    const d = dir();
    try {
      const rows = await checkDependencySurface(d, {
        advisories: async () => {
          throw new Error("boom");
        },
      });
      assert.ok(rows.find((r) => r.name === NAME));
      assert.equal(rows.find((r) => r.name === ADV)?.status, "skip");
    } finally {
      rmTemp(d);
    }
  });
});

describe("advisoryOptionsFor", () => {
  const withEnv = async (env: Record<string, string>, run: () => Promise<void>) => {
    const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("gives no lookup unless asked for: package names must not leave by default", async () => {
    const d = project({ "package.json": {}, ".kit.toml": '[project]\nname = "t"\n' });
    try {
      await withEnv({ KIT_ADVISORIES: "" }, async () => {
        delete process.env.KIT_ADVISORIES;
        assert.deepEqual(await advisoryOptionsFor(d), {});
      });
    } finally {
      rmTemp(d);
    }
  });

  it("gives a lookup when [scan] advisories = true, and KIT_ADVISORIES=0 still wins", async () => {
    const d = project({
      "package.json": {},
      ".kit.toml": '[project]\nname = "t"\n\n[scan]\nadvisories = true\n',
    });
    try {
      await withEnv({ KIT_ADVISORIES: "" }, async () => {
        delete process.env.KIT_ADVISORIES;
        assert.ok((await advisoryOptionsFor(d)).advisories);
      });
      await withEnv({ KIT_ADVISORIES: "0" }, async () => {
        assert.deepEqual(await advisoryOptionsFor(d), {});
      });
    } finally {
      rmTemp(d);
    }
  });

  it("gives no lookup when KIT_ADVISORIES=0", async () => {
    const d = project({ "package.json": {} });
    try {
      await withEnv({ KIT_ADVISORIES: "0" }, async () => {
        assert.deepEqual(await advisoryOptionsFor(d), {});
      });
    } finally {
      rmTemp(d);
    }
  });

  it("makes no request in an air gap and says the answer is missing", async () => {
    const d = project({ "package.json": {} });
    try {
      await withEnv(
        {
          KIT_ADVISORIES: "1",
          KIT_AIRGAP: "1",
          KIT_ADVISORY_CACHE: join(d, "no-cache.json"),
        },
        async () => {
          const options = await advisoryOptionsFor(d);
          assert.ok(options.advisories);
          const got = await options.advisories([{ name: "x", version: "1.0.0" }]);
          assert.equal(got.checked, false);
          assert.match(got.note ?? "", /air gap/);
        },
      );
    } finally {
      rmTemp(d);
    }
  });
});
