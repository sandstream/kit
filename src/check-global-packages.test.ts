/**
 * Z3, global packages. `kit check` scanned the lockfiles of the project and never looked at what is
 * installed globally: `npm`, `corepack` and every `npm i -g` package sit in each Node install's
 * `lib/node_modules`, run with the user's rights, and no lockfile names them. This reads those
 * folders (nothing is executed to find them), asks osv-scanner about the result through a synthetic
 * lockfile, and says where each vulnerable package lives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkGlobalPackages,
  inventoryGlobalPackages,
  judgeGlobalPackages,
  syntheticLockfile,
  type GlobalDeps,
  type GlobalPackage,
} from "./check-global-packages.js";
import type { InstallEntry, InstallRoots } from "./check-installs.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function machine(spec: Record<string, string | null>): { root: string; roots: InstallRoots } {
  const root = mkdtempSync(join(tmpdir(), "kit-globals-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    mkdirSync(content === null ? full : dirname(full), { recursive: true });
    if (content !== null) writeFileSync(full, content);
  }
  const roots: InstallRoots = {
    home: join(root, "home"),
    env: {},
    brewPrefixes: [join(root, "brew")],
    systemPrefix: join(root, "usr-local"),
  };
  return { root, roots };
}

const pkgJson = (name: string, version: string) => JSON.stringify({ name, version });

describe("inventoryGlobalPackages", () => {
  it("reads the global packages of each Node install, with where they live", () => {
    const { root, roots } = machine({
      "home/.local/share/mise/installs/node/22.23.4/lib/node_modules/npm/package.json": pkgJson(
        "npm",
        "10.9.0",
      ),
      "home/.local/share/mise/installs/node/22.23.4/lib/node_modules/corepack/package.json":
        pkgJson("corepack", "0.30.0"),
      "home/.nvm/versions/node/v18.20.0/lib/node_modules/typescript/package.json": pkgJson(
        "typescript",
        "5.4.5",
      ),
    });
    try {
      const installs: InstallEntry[] = [
        {
          manager: "mise",
          version: "22.23.4",
          dir: join(roots.home, ".local/share/mise/installs/node/22.23.4"),
        },
        {
          manager: "nvm",
          version: "18.20.0",
          dir: join(roots.home, ".nvm/versions/node/v18.20.0"),
        },
      ];
      const got = inventoryGlobalPackages(roots, installs)
        .map((p) => `${p.name}@${p.version} ${p.where.join("|")}`)
        .sort();
      assert.deepEqual(got, [
        "corepack@0.30.0 mise node 22.23.4",
        "npm@10.9.0 mise node 22.23.4",
        "typescript@5.4.5 nvm node 18.20.0",
      ]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("inventoryGlobalPackages: other layouts", () => {
  it("reads scoped packages, and the fnm and Homebrew layouts", () => {
    const { root, roots } = machine({
      "home/.local/share/fnm/node-versions/v20.11.1/installation/lib/node_modules/@scope/tool/package.json":
        pkgJson("@scope/tool", "1.2.3"),
      "brew/lib/node_modules/yarn/package.json": pkgJson("yarn", "1.22.22"),
    });
    try {
      const installs: InstallEntry[] = [
        {
          manager: "fnm",
          version: "20.11.1",
          dir: join(roots.home, ".local/share/fnm/node-versions/v20.11.1"),
        },
        {
          manager: "homebrew",
          version: "26.7.0",
          dir: join(roots.brewPrefixes[0], "Cellar/node/26.7.0"),
        },
      ];
      const names = inventoryGlobalPackages(roots, installs)
        .map((p) => p.name)
        .sort();
      assert.deepEqual(names, ["@scope/tool", "yarn"]);
    } finally {
      rmTemp(root);
    }
  });

  it("reads the npm prefix from NPM_CONFIG_PREFIX and from ~/.npmrc", () => {
    const { root, roots } = machine({
      "elsewhere/lib/node_modules/a/package.json": pkgJson("a", "1.0.0"),
      "home/.npm-global/lib/node_modules/b/package.json": pkgJson("b", "2.0.0"),
      "home/.npmrc": `prefix=${"${HOME}"}/.npm-global\n`,
    });
    try {
      const viaEnv = inventoryGlobalPackages(
        { ...roots, env: { NPM_CONFIG_PREFIX: join(root, "elsewhere") } },
        [],
      );
      assert.deepEqual(
        viaEnv.map((p) => p.name),
        ["a"],
      );
      const viaRc = inventoryGlobalPackages({ ...roots, env: { HOME: roots.home } }, []);
      assert.deepEqual(
        viaRc.map((p) => p.name),
        ["b"],
      );
    } finally {
      rmTemp(root);
    }
  });
});

describe("inventoryGlobalPackages: what it leaves out and how it merges", () => {
  it("skips a package linked from elsewhere, a folder whose name does not match, and a bad version", () => {
    const { root, roots } = machine({
      "home/.npm-global/lib/node_modules/real/package.json": pkgJson("real", "1.0.0"),
      "home/.npm-global/lib/node_modules/liar/package.json": pkgJson("other-name", "1.0.0"),
      "home/.npm-global/lib/node_modules/badver/package.json": pkgJson("badver", "latest"),
      "home/.npm-global/lib/node_modules/nopkg/readme.txt": "x",
      "home/dev/linked/package.json": pkgJson("linked", "9.9.9"),
    });
    try {
      symlinkSync(
        join(roots.home, "dev/linked"),
        join(roots.home, ".npm-global/lib/node_modules/linked"),
      );
      const got = inventoryGlobalPackages(
        { ...roots, env: { NPM_CONFIG_PREFIX: join(roots.home, ".npm-global") } },
        [],
      );
      assert.deepEqual(
        got.map((p) => p.name),
        ["real"],
      );
    } finally {
      rmTemp(root);
    }
  });

  it("lists one package once, with every place it lives, and keeps two versions apart", () => {
    const { root, roots } = machine({
      "home/.local/share/mise/installs/node/22.23.4/lib/node_modules/npm/package.json": pkgJson(
        "npm",
        "10.9.0",
      ),
      "home/.nvm/versions/node/v20.1.0/lib/node_modules/npm/package.json": pkgJson("npm", "10.9.0"),
      "home/.nvm/versions/node/v18.1.0/lib/node_modules/npm/package.json": pkgJson("npm", "9.6.7"),
    });
    try {
      const installs: InstallEntry[] = [
        {
          manager: "mise",
          version: "22.23.4",
          dir: join(roots.home, ".local/share/mise/installs/node/22.23.4"),
        },
        { manager: "nvm", version: "20.1.0", dir: join(roots.home, ".nvm/versions/node/v20.1.0") },
        { manager: "nvm", version: "18.1.0", dir: join(roots.home, ".nvm/versions/node/v18.1.0") },
      ];
      const got = inventoryGlobalPackages(roots, installs);
      assert.equal(got.length, 2);
      const tenNine = got.find((p) => p.version === "10.9.0");
      assert.equal(tenNine?.where.length, 2);
    } finally {
      rmTemp(root);
    }
  });

  it("returns nothing for a machine with no global packages", () => {
    const { root, roots } = machine({ "home/.keep": "" });
    try {
      assert.deepEqual(inventoryGlobalPackages(roots, []), []);
    } finally {
      rmTemp(root);
    }
  });
});

const g = (name: string, version: string, where: string[] = ["npm prefix"]): GlobalPackage => ({
  name,
  version,
  where,
});

describe("syntheticLockfile", () => {
  it("is a package-lock v3 with one entry per package, two versions of one name kept apart", () => {
    const lock = JSON.parse(
      syntheticLockfile([g("npm", "10.9.0"), g("npm", "9.6.7"), g("@scope/tool", "1.0.0")]),
    ) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string }>;
    };
    assert.equal(lock.lockfileVersion, 3);
    const entries = Object.entries(lock.packages).filter(([k]) => k !== "");
    assert.equal(entries.length, 3);
    for (const [key] of entries) assert.match(key, /node_modules\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
    assert.deepEqual(entries.map(([, v]) => v.version).sort(), ["1.0.0", "10.9.0", "9.6.7"]);
  });

  it("leaves out a name that is not a package name, so nothing odd reaches the scanner", () => {
    const lock = JSON.parse(syntheticLockfile([g("../../etc", "1.0.0"), g("ok", "1.0.0")])) as {
      packages: Record<string, unknown>;
    };
    assert.equal(Object.keys(lock.packages).filter((k) => k !== "").length, 1);
  });
});

const osvOut = (vulns: Record<string, string[]>) =>
  JSON.stringify({
    results: [
      {
        source: { path: "package-lock.json", type: "lockfile" },
        packages: Object.entries(vulns).map(([key, ids]) => {
          const at = key.lastIndexOf("@");
          return {
            package: { name: key.slice(0, at), version: key.slice(at + 1), ecosystem: "npm" },
            vulnerabilities: ids.map((id) => ({ id })),
          };
        }),
      },
    ],
  });

describe("judgeGlobalPackages", () => {
  const pkgs = [g("npm", "10.9.0", ["mise node 22.23.4"]), g("lodash", "4.17.20", ["npm prefix"])];

  it("skips when there are no global packages", () => {
    assert.equal(judgeGlobalPackages([], osvOut({})).status, "skip");
  });

  it("passes when the scanner finds nothing, and says how many packages it looked at", () => {
    const r = judgeGlobalPackages(pkgs, osvOut({}));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /2 global npm packages/);
  });

  it("warns, naming the vulnerable package and where it lives", () => {
    const r = judgeGlobalPackages(pkgs, osvOut({ "lodash@4.17.20": ["GHSA-29mw-wpgm-hmr9"] }));
    assert.equal(r.status, "warn");
    assert.equal(r.name, "global npm packages");
    assert.match(r.detail, /lodash 4\.17\.20/);
    assert.match(r.detail, /npm prefix/);
    assert.doesNotMatch(
      r.detail,
      /osv-scanner -r \./,
      "the project's own rerun hint is wrong for a global package",
    );
  });

  it("suggests the global update, as text, for a plain package name", () => {
    const r = judgeGlobalPackages(pkgs, osvOut({ "lodash@4.17.20": ["GHSA-x"] }));
    assert.match(r.suggestion ?? "", /npm install -g lodash@latest/);
    assert.doesNotMatch(r.suggestion ?? "", /npm update/);
  });

  it("is unverified, never green, when the scanner output cannot be read", () => {
    const r = judgeGlobalPackages(pkgs, "not json");
    assert.equal(r.status, "warn");
    assert.match(r.detail, /unverified/i);
  });

  it("is unverified when no scanner output was produced at all", () => {
    assert.match(judgeGlobalPackages(pkgs, null).detail, /unverified/i);
  });

  it("prints nothing a folder name could use to forge a line", () => {
    const r = judgeGlobalPackages(
      [g("lodash", "4.17.20", ["x\nTRIAGE PASSED"])],
      osvOut({ "lodash@4.17.20": ["GHSA-x"] }),
    );
    assert.equal(/[\n\u001b]/.test(r.detail + (r.suggestion ?? "")), false);
  });
});

const makeDeps = (over: Partial<GlobalDeps> & { ran?: string[] } = {}): GlobalDeps => ({
  platform: "linux",
  roots: { home: "/h", env: {}, brewPrefixes: [], systemPrefix: "/none" },
  installs: () => [],
  packages: () => [g("lodash", "4.17.20")],
  detectNode: () => ({ declared: null }),
  osvBin: async () => "/bin/osv-scanner",
  runOsv: async () => ({ stdout: osvOut({ "lodash@4.17.20": ["GHSA-x"] }), code: 1 }),
  airGap: async () => ({ enabled: false, mirrors: {} }),
  ...over,
});

describe("checkGlobalPackages", () => {
  const deps = makeDeps;

  it("returns one row from what the scanner reports", async () => {
    const rows = await checkGlobalPackages("/p", deps());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "warn");
  });

  it("returns nothing for a project that does not use Node", async () => {
    assert.deepEqual(await checkGlobalPackages("/p", deps({ detectNode: () => null })), []);
  });
});

describe("checkGlobalPackages: when it does not look", () => {
  const deps = makeDeps;
  it("does not look on Windows, and says so", async () => {
    const rows = await checkGlobalPackages("/p", deps({ platform: "win32" }));
    assert.equal(rows[0].status, "skip");
    assert.match(rows[0].detail, /Windows/);
  });

  it("does not query when air-gap is on, and says why", async () => {
    let asked = 0;
    const rows = await checkGlobalPackages(
      "/p",
      deps({
        airGap: async () => ({ enabled: true, mirrors: {} }),
        runOsv: async () => {
          asked++;
          return { stdout: "", code: 0 };
        },
      }),
    );
    assert.equal(asked, 0);
    assert.match(rows[0].detail, /air-gap/i);
    assert.equal(rows[0].status, "warn");
  });

  it("says the packages are not scanned when osv-scanner is not installed", async () => {
    const rows = await checkGlobalPackages("/p", deps({ osvBin: async () => null }));
    assert.equal(rows[0].status, "warn");
    assert.match(rows[0].detail, /osv-scanner is not installed/);
  });

  it("does not look when there are no global packages", async () => {
    let asked = 0;
    const rows = await checkGlobalPackages(
      "/p",
      deps({
        packages: () => [],
        runOsv: async () => {
          asked++;
          return { stdout: "", code: 0 };
        },
      }),
    );
    assert.equal(rows[0].status, "skip");
    assert.equal(asked, 0);
  });

  it("reports unverified, and does not throw, when the scanner run fails", async () => {
    const rows = await checkGlobalPackages(
      "/p",
      deps({
        runOsv: async () => {
          throw new Error("spawn failed");
        },
      }),
    );
    assert.equal(rows[0].status, "warn");
    assert.match(rows[0].detail, /unverified/i);
  });
});
