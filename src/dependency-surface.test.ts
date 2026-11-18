import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyseSurface,
  maxNodeMajor,
  type NpmLock,
  type NpmLockEntry,
  type ProjectManifest,
  type SurfaceUsage,
} from "./dependency-surface.js";

// A lockfile entry for a package at the top of node_modules.
const pkg = (version: string, extra: Partial<NpmLockEntry> = {}): NpmLockEntry => ({
  version,
  ...extra,
});

/** `big` is a prod dependency with a large private subtree, `small` brings nothing. */
function fixture(): { lock: NpmLock; manifest: ProjectManifest } {
  const packages: Record<string, NpmLockEntry> = {
    "": { name: "app", version: "1.0.0" },
    "node_modules/big": pkg("1.0.0", { dependencies: { "big-a": "^1", "big-b": "^1" } }),
    "node_modules/big-a": pkg("1.0.0", { dependencies: { shared: "^1" } }),
    "node_modules/big-b": pkg("1.0.0"),
    "node_modules/shared": pkg("1.0.0"),
    "node_modules/small": pkg("2.0.0", { dependencies: { shared: "^1" } }),
    "node_modules/tool": pkg("3.0.0", { dev: true, dependencies: { "tool-a": "^1" } }),
    "node_modules/tool-a": pkg("1.0.0", { dev: true }),
  };
  return {
    lock: { lockfileVersion: 3, packages },
    manifest: {
      dependencies: { big: "1.0.0", small: "2.0.0" },
      devDependencies: { tool: "3.0.0" },
      scripts: { lint: "tool --fix" },
    },
  };
}

const usage = (sites: Record<string, number>, text = ""): SurfaceUsage => ({
  importSites: new Map(Object.entries(sites)),
  scriptText: text,
});

describe("analyseSurface totals and closures", () => {
  it("counts direct, shipped and development-only packages by unique name", () => {
    const { lock, manifest } = fixture();
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(r);
    assert.deepEqual(r.totals, {
      direct: 3,
      directProd: 2,
      directDev: 1,
      all: 7,
      shipped: 5,
      devOnly: 2,
    });
  });

  it("gives each direct dependency its closure and what is reachable only through it", () => {
    const { lock, manifest } = fixture();
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(r);
    const big = r.direct.find((d) => d.name === "big");
    const small = r.direct.find((d) => d.name === "small");
    // big brings big-a, big-b, shared; shared is also reached through small, so it is not "only".
    assert.deepEqual({ brings: big?.brings, only: big?.onlyThrough }, { brings: 3, only: 2 });
    assert.deepEqual({ brings: small?.brings, only: small?.onlyThrough }, { brings: 1, only: 0 });
  });

  it("returns null for a lockfile that carries no package list (version 1)", () => {
    const r = analyseSurface({
      lock: { lockfileVersion: 1 },
      manifest: { dependencies: { a: "1.0.0" } },
      usage: usage({}),
    });
    assert.equal(r, null);
  });

  it("does not count workspace links as third-party packages", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/mine"] = { resolved: "packages/mine", link: true };
    lock.packages!["packages/mine"] = { version: "1.0.0" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.equal(r?.totals.all, 7);
  });
});

describe("analyseSurface findings", () => {
  const rules = (r: ReturnType<typeof analyseSurface>): string[] =>
    (r?.findings ?? []).map((f) => `${f.rule}:${f.subject}`).sort();

  it("flags a dependency that nothing imports and no script or config mentions", () => {
    const { lock, manifest } = fixture();
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 2 }, "tool") });
    assert.ok(rules(r).includes("unused:small"));
    assert.ok(!rules(r).includes("unused:big"));
    assert.ok(!rules(r).includes("unused:tool"), "a dev tool named in a script is in use");
  });

  it("never calls a @types package unused", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/@types/x"] = pkg("1.0.0", { dev: true });
    manifest.devDependencies = { ...manifest.devDependencies, "@types/x": "1.0.0" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(!rules(r).some((x) => x.includes("@types/x")));
  });

  it("flags a heavy dependency with few import sites and says how much is only through it", () => {
    const { lock, manifest } = fixture();
    // Make big heavy: 24 extra packages only it needs.
    const extra = Array.from({ length: 24 }, (_, i) => `leaf-${i}`);
    for (const n of extra) lock.packages![`node_modules/${n}`] = pkg("1.0.0");
    lock.packages!["node_modules/big"].dependencies = Object.fromEntries(
      ["big-a", "big-b", ...extra].map((n) => [n, "^1"]),
    );
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    const heavy = r?.findings.find((f) => f.rule === "heavy" && f.subject === "big");
    assert.ok(heavy, "big brings 27 packages and is imported in one file");
    assert.match(heavy.message, /brings 27 packages/);
    assert.match(heavy.message, /26 only through it/);
    assert.match(heavy.message, /1 file/);
  });

  it("does not call a heavy dependency heavy when it is used widely", () => {
    const { lock, manifest } = fixture();
    const extra = Array.from({ length: 24 }, (_, i) => `leaf-${i}`);
    for (const n of extra) lock.packages![`node_modules/${n}`] = pkg("1.0.0");
    lock.packages!["node_modules/big"].dependencies = Object.fromEntries(
      extra.map((n) => [n, "^1"]),
    );
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 40, small: 1 }, "tool") });
    assert.ok(!rules(r).includes("heavy:big"));
  });
});

describe("analyseSurface findings: Node floor, versions and scripts", () => {
  it("lists packages that need an older Node than the project's floor", () => {
    const { lock, manifest } = fixture();
    manifest.engines = { node: ">=20" };
    lock.packages!["node_modules/shared"].engines = { node: "<=16" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    const f = r?.findings.find((x) => x.rule === "node-pin");
    assert.ok(f);
    assert.match(f.message, /shared/);
    assert.match(f.message, /Node 20/);
  });

  it("says nothing about Node when the project declares no floor", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/shared"].engines = { node: "<=16" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(!r?.findings.some((x) => x.rule === "node-pin"));
  });

  it("lists a package that is installed in more than one version", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/big-a/node_modules/shared"] = pkg("2.0.0");
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    const f = r?.findings.find((x) => x.rule === "duplicates");
    assert.ok(f);
    assert.match(f.message, /shared \(1\.0\.0, 2\.0\.0\)/);
  });

  it("lists shipped packages that run install scripts, and ignores development-only ones", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/big-b"].hasInstallScript = true;
    lock.packages!["node_modules/tool-a"].hasInstallScript = true;
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    const f = r?.findings.find((x) => x.rule === "install-scripts");
    assert.ok(f);
    assert.match(f.message, /big-b/);
    assert.doesNotMatch(f.message, /tool-a/);
  });

  it("finds nothing to report in a small clean tree", () => {
    const lock: NpmLock = {
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/a": pkg("1.0.0") },
    };
    const r = analyseSurface({
      lock,
      manifest: { dependencies: { a: "1.0.0" } },
      usage: usage({ a: 3 }),
    });
    assert.deepEqual(r?.findings, []);
  });
});

describe("maxNodeMajor", () => {
  it("reads the highest Node major an engines range allows", () => {
    assert.equal(maxNodeMajor("<=16"), 16);
    assert.equal(maxNodeMajor("<17"), 16);
    assert.equal(maxNodeMajor("^14.17.0"), 14);
    assert.equal(maxNodeMajor("14.x"), 14);
    assert.equal(maxNodeMajor("^14 || ^16 || ^18"), 18);
    assert.equal(maxNodeMajor(">=14"), Infinity);
    assert.equal(maxNodeMajor("^14 || >=16"), Infinity);
  });

  it("returns Infinity for what it cannot read, so an unknown range is never reported", () => {
    assert.equal(maxNodeMajor("lts/*"), Infinity);
    assert.equal(maxNodeMajor(""), Infinity);
  });
});

describe("analyseSurface: what counts toward a dependency's weight and use", () => {
  const manyLeaves = (n: number): string[] => Array.from({ length: n }, (_, i) => `leaf-${i}`);

  it("does not count a peer dependency the project already depends on directly", () => {
    const packages: Record<string, NpmLockEntry> = {
      "": {},
      "node_modules/host": pkg("1.0.0", {
        dependencies: Object.fromEntries(manyLeaves(30).map((n) => [n, "^1"])),
      }),
      "node_modules/plugin": pkg("1.0.0", { peerDependencies: { host: "^1" } }),
    };
    for (const n of manyLeaves(30)) packages[`node_modules/${n}`] = pkg("1.0.0");
    const r = analyseSurface({
      lock: { lockfileVersion: 3, packages },
      manifest: { dependencies: { host: "1.0.0", plugin: "1.0.0" } },
      usage: usage({ host: 5, plugin: 5 }),
    });
    const plugin = r?.direct.find((d) => d.name === "plugin");
    assert.equal(plugin?.brings, 0, "the host it plugs into is the project's own dependency");
    assert.ok(!r?.findings.some((f) => f.rule === "heavy" && f.subject === "plugin"));
  });

  it("measures a runtime dependency by the production files that import it, not by its tests", () => {
    const { lock, manifest } = fixture();
    const extra = manyLeaves(24);
    for (const n of extra) lock.packages![`node_modules/${n}`] = pkg("1.0.0");
    lock.packages!["node_modules/big"].dependencies = Object.fromEntries(
      extra.map((n) => [n, "^1"]),
    );
    const r = analyseSurface({
      lock,
      manifest,
      usage: {
        importSites: new Map([
          ["big", 6],
          ["small", 1],
        ]),
        productionImportSites: new Map([
          ["big", 1],
          ["small", 1],
        ]),
        scriptText: "tool",
      },
    });
    const heavy = r?.findings.find((f) => f.rule === "heavy" && f.subject === "big");
    assert.ok(heavy, "one production file imports it, the other five are tests");
    assert.match(heavy.message, /imported in 1 file/);
    assert.match(heavy.message, /5 more in tests/);
  });

  it("still counts a test import as use, so a dependency only the tests need is not called unused", () => {
    const { lock, manifest } = fixture();
    const r = analyseSurface({
      lock,
      manifest,
      usage: {
        importSites: new Map([
          ["big", 1],
          ["small", 2],
        ]),
        productionImportSites: new Map([["big", 1]]),
        scriptText: "tool",
      },
    });
    assert.ok(!r?.findings.some((f) => f.rule === "unused" && f.subject === "small"));
  });
});

describe("analyseSurface: what is worth reporting", () => {
  const leaves = (n: number): string[] => Array.from({ length: n }, (_, i) => `leaf-${i}`);

  it("does not call a dependency heavy when its packages are shared with the rest of the tree", () => {
    const packages: Record<string, NpmLockEntry> = {
      "": {},
      "node_modules/ui-a": pkg("1.0.0", {
        dependencies: Object.fromEntries(leaves(30).map((n) => [n, "^1"])),
      }),
      "node_modules/ui-b": pkg("1.0.0", {
        dependencies: Object.fromEntries(leaves(30).map((n) => [n, "^1"])),
      }),
    };
    for (const n of leaves(30)) packages[`node_modules/${n}`] = pkg("1.0.0");
    const r = analyseSurface({
      lock: { lockfileVersion: 3, packages },
      manifest: { dependencies: { "ui-a": "1.0.0", "ui-b": "1.0.0" } },
      usage: usage({ "ui-a": 1, "ui-b": 1 }),
    });
    assert.deepEqual(
      r?.findings.filter((f) => f.rule === "heavy"),
      [],
      "removing one frees nothing",
    );
  });

  it("only judges runtime dependencies as unused, because a tool can be run without being named", () => {
    const { lock, manifest } = fixture();
    manifest.devDependencies = { tool: "3.0.0" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "") });
    assert.ok(!r?.findings.some((f) => f.rule === "unused" && f.subject === "tool"));
  });
});

describe("analyseSurface: exclusions and ordering", () => {
  it("ignores a platform-specific optional package when it looks for a Node floor", () => {
    const { lock, manifest } = fixture();
    manifest.engines = { node: ">=22" };
    lock.packages!["node_modules/shared"] = pkg("1.0.0", {
      optional: true,
      os: ["win32"],
      cpu: ["ia32"],
      engines: { node: "^20.9.0" },
    });
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(!r?.findings.some((f) => f.rule === "node-pin"));
  });

  it("orders findings of one rule by how much each would free", () => {
    const packages: Record<string, NpmLockEntry> = { "": {} };
    const manifest: ProjectManifest = { dependencies: {} };
    for (const [name, n] of [
      ["small-dep", 16],
      ["big-dep", 40],
    ] as const) {
      const own = Array.from({ length: n }, (_, i) => `${name}-leaf-${i}`);
      packages[`node_modules/${name}`] = pkg("1.0.0", {
        dependencies: Object.fromEntries(own.map((l) => [l, "^1"])),
      });
      for (const l of own) packages[`node_modules/${l}`] = pkg("1.0.0");
      manifest.dependencies![name] = "1.0.0";
    }
    const r = analyseSurface({
      lock: { lockfileVersion: 3, packages },
      manifest,
      usage: usage({}),
    });
    const heavy = r?.findings.filter((f) => f.rule === "heavy").map((f) => f.subject);
    assert.deepEqual(heavy, ["big-dep", "small-dep"]);
  });

  it("never calls a @types package unused, even when it is listed as a runtime dependency", () => {
    const { lock, manifest } = fixture();
    lock.packages!["node_modules/@types/react-window"] = pkg("1.0.0");
    manifest.dependencies = { ...manifest.dependencies, "@types/react-window": "1.0.0" };
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 1, small: 1 }, "tool") });
    assert.ok(!r?.findings.some((f) => f.subject === "@types/react-window"));
  });
});

describe("analyseSurface: a framework that takes most of the shipped tree", () => {
  const leaves = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  function tree(frameworkSites: number): ReturnType<typeof analyseSurface> {
    const own = leaves("fw", 60);
    const packages: Record<string, NpmLockEntry> = {
      "": {},
      "node_modules/framework": pkg("1.0.0", {
        dependencies: Object.fromEntries(own.map((n) => [n, "^1"])),
      }),
      "node_modules/small": pkg("1.0.0"),
    };
    for (const n of own) packages[`node_modules/${n}`] = pkg("1.0.0");
    return analyseSurface({
      lock: { lockfileVersion: 3, packages },
      manifest: { dependencies: { framework: "1.0.0", small: "1.0.0" } },
      usage: usage({ framework: frameworkSites, small: 4 }),
    });
  }

  it("flags a widely imported dependency that accounts for most of what ships", () => {
    const f = tree(40)?.findings.find((x) => x.rule === "dominant");
    assert.ok(f, "60 of 62 shipped packages come only through it");
    assert.match(
      f.message,
      /framework: 60 of the 62 shipped packages \(97%\) come only through it/,
    );
    assert.match(f.message, /imported in 40 files/);
  });

  it("does not flag it twice when it is already heavy", () => {
    const r = tree(2);
    assert.ok(r?.findings.some((x) => x.rule === "heavy" && x.subject === "framework"));
    assert.ok(!r?.findings.some((x) => x.rule === "dominant"));
  });

  it("does not flag a dependency that takes a small share, or only development tools", () => {
    const { lock, manifest } = fixture();
    const r = analyseSurface({ lock, manifest, usage: usage({ big: 40, small: 40 }, "tool") });
    assert.ok(!r?.findings.some((x) => x.rule === "dominant"));
  });
});
