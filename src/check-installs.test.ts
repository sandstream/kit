/**
 * Z2, all installs. `kit check` judged the one Node that answers `node --version`. A machine with
 * Node 25.8.0 first in PATH and 26.7.0 installed lower down reads as fine if only the newer one is
 * looked at, and the one that runs is the old one. This lists every install a version manager or
 * Homebrew keeps, says which one PATH runs, judges each with the same end-of-life and security
 * data as the runtime row, and proposes (never runs) removing the ones that are not safe to keep.
 *
 * The versions are read from directory names, so finding them executes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkRuntimeInstalls,
  classifyBinary,
  inventoryNodeInstalls,
  judgeInstalls,
  type InstallEntry,
  type InstallRoots,
  type InstallFacts,
} from "./check-installs.js";
import type { RuntimeAssessment } from "./upstream-runtimes.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function machine(spec: Record<string, string | null>): { root: string; roots: InstallRoots } {
  const root = mkdtempSync(join(tmpdir(), "kit-installs-"));
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

const node = (
  m: InstallEntry["manager"],
  version: string,
  dir = `/x/${version}`,
): InstallEntry => ({
  manager: m,
  version,
  dir,
});

describe("inventoryNodeInstalls", () => {
  it("finds the installs of mise, nvm, fnm, volta and Homebrew, by folder name", () => {
    const { root, roots } = machine({
      "home/.local/share/mise/installs/node/22.23.4": null,
      "home/.local/share/mise/installs/node/25.8.0": null,
      "home/.nvm/versions/node/v18.20.0": null,
      "home/.local/share/fnm/node-versions/v20.11.1/installation": null,
      "home/.volta/tools/image/node/24.13.1": null,
      "brew/Cellar/node/26.7.0_1": null,
      "brew/Cellar/node@22/22.12.0": null,
    });
    try {
      const got = inventoryNodeInstalls(roots)
        .map((i) => `${i.manager} ${i.version}`)
        .sort();
      assert.deepEqual(got, [
        "fnm 20.11.1",
        "homebrew 22.12.0",
        "homebrew 26.7.0",
        "mise 22.23.4",
        "mise 25.8.0",
        "nvm 18.20.0",
        "volta 24.13.1",
      ]);
    } finally {
      rmTemp(root);
    }
  });

  it("skips alias folders that are symbolic links, and names that are not a full version", () => {
    const { root, roots } = machine({
      "home/.local/share/mise/installs/node/22.23.4": null,
      "home/.local/share/mise/installs/node/lts": null,
      "home/.local/share/mise/installs/node/22.23": null,
      "home/.local/share/mise/installs/node/1.2.3-evil": null,
      "home/.nvm/versions/node/v18": null,
    });
    try {
      symlinkSync(
        join(roots.home, ".local/share/mise/installs/node/22.23.4"),
        join(roots.home, ".local/share/mise/installs/node/22"),
      );
      const got = inventoryNodeInstalls(roots).map((i) => i.version);
      assert.deepEqual(got, ["22.23.4"]);
    } finally {
      rmTemp(root);
    }
  });
});

describe("inventoryNodeInstalls: other layouts", () => {
  it("reads a version from the node headers of an install outside any manager", () => {
    const { root, roots } = machine({
      "usr-local/bin/node": "#!/bin/sh\n",
      "usr-local/include/node/node_version.h":
        "#define NODE_MAJOR_VERSION 20\n#define NODE_MINOR_VERSION 9\n#define NODE_PATCH_VERSION 0\n",
    });
    try {
      assert.deepEqual(
        inventoryNodeInstalls(roots).map((i) => `${i.manager} ${i.version}`),
        ["system 20.9.0"],
      );
    } finally {
      rmTemp(root);
    }
  });

  it("honours MISE_DATA_DIR and NVM_DIR", () => {
    const { root, roots } = machine({
      "elsewhere/mise/installs/node/22.1.0": null,
      "elsewhere/nvm/versions/node/v20.1.0": null,
    });
    try {
      const env = {
        MISE_DATA_DIR: join(root, "elsewhere/mise"),
        NVM_DIR: join(root, "elsewhere/nvm"),
      };
      const got = inventoryNodeInstalls({ ...roots, env }).map((i) => `${i.manager} ${i.version}`);
      assert.deepEqual(got.sort(), ["mise 22.1.0", "nvm 20.1.0"]);
    } finally {
      rmTemp(root);
    }
  });

  it("returns nothing for a machine with no installs", () => {
    const { root, roots } = machine({ "home/.keep": "" });
    try {
      assert.deepEqual(inventoryNodeInstalls(roots), []);
    } finally {
      rmTemp(root);
    }
  });
});

describe("classifyBinary", () => {
  const roots: InstallRoots = {
    home: "/home/u",
    env: {},
    brewPrefixes: ["/opt/homebrew"],
    systemPrefix: "/usr/local",
  };

  it("names the manager and version from where the real binary lives", () => {
    assert.deepEqual(
      classifyBinary("/home/u/.local/share/mise/installs/node/25.8.0/bin/node", roots),
      {
        manager: "mise",
        version: "25.8.0",
        shim: false,
      },
    );
    assert.deepEqual(classifyBinary("/opt/homebrew/Cellar/node/26.7.0_1/bin/node", roots), {
      manager: "homebrew",
      version: "26.7.0",
      shim: false,
    });
    assert.deepEqual(classifyBinary("/home/u/.nvm/versions/node/v18.20.0/bin/node", roots), {
      manager: "nvm",
      version: "18.20.0",
      shim: false,
    });
  });

  it("calls a version manager shim a shim, whose version depends on the project", () => {
    assert.deepEqual(classifyBinary("/home/u/.local/share/mise/shims/node", roots), {
      manager: "mise",
      version: null,
      shim: true,
    });
    assert.deepEqual(classifyBinary("/home/u/.volta/bin/node", roots), {
      manager: "volta",
      version: null,
      shim: true,
    });
  });

  it("calls anything else other, with no version known from the path", () => {
    assert.deepEqual(classifyBinary("/somewhere/else/bin/node", roots), {
      manager: "other",
      version: null,
      shim: false,
    });
  });
});

const bad = (verdict: RuntimeAssessment["verdict"]): RuntimeAssessment => ({
  verdict,
  latest: null,
  evidence: [],
});
const good: RuntimeAssessment = { verdict: "current", latest: null, evidence: [] };

function facts(over: Partial<InstallFacts> = {}): InstallFacts {
  return {
    installs: [node("mise", "25.8.0"), node("homebrew", "26.7.0")],
    winner: { manager: "mise", version: "25.8.0", shim: false },
    assess: (v) => (v === "25.8.0" ? bad("end of life") : good),
    projectMajor: null,
    ...over,
  };
}

describe("judgeInstalls", () => {
  it("skips when no install is found anywhere", () => {
    const r = judgeInstalls(facts({ installs: [], winner: null }));
    assert.equal(r.status, "skip");
  });

  it("fails, naming the winner, when the install PATH runs is end of life and a newer one sits lower", () => {
    const r = judgeInstalls(facts());
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /PATH runs Node 25\.8\.0 \(mise\)/);
    assert.match(r.detail, /end of life/);
    assert.match(r.detail, /26\.7\.0 \(homebrew\) is installed but comes later in PATH/);
    assert.match(r.suggestion ?? "", /mise uninstall node@25\.8\.0/);
  });

  it("fails for a winner that lacks a security release, with no newer install to point at", () => {
    const r = judgeInstalls(
      facts({
        installs: [node("mise", "24.13.1")],
        winner: { manager: "mise", version: "24.13.1", shim: false },
        assess: () => bad("security release available"),
      }),
    );
    assert.equal(r.status, "fail");
    assert.doesNotMatch(r.detail, /comes later in PATH/);
  });

  it("warns about unused installs that are end of life, and proposes the removal for each manager", () => {
    const r = judgeInstalls(
      facts({
        installs: [
          node("homebrew", "26.7.0", "/opt/homebrew/Cellar/node/26.7.0"),
          node("mise", "18.20.0"),
          node("nvm", "16.20.2"),
          node("fnm", "14.21.3"),
          node("volta", "12.22.12", "/home/u/.volta/tools/image/node/12.22.12"),
          node("system", "10.24.1", "/usr/local"),
        ],
        winner: { manager: "homebrew", version: "26.7.0", shim: false },
        assess: (v) => (v === "26.7.0" ? good : bad("end of life")),
      }),
    );
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "medium");
    assert.match(r.detail, /5 unused installs/);
    const s = r.suggestion ?? "";
    assert.match(s, /mise uninstall node@18\.20\.0/);
    assert.match(s, /nvm uninstall 16\.20\.2/);
    assert.match(s, /fnm uninstall 14\.21\.3/);
    assert.match(s, /volta/i);
    assert.match(s, /outside a version manager/);
    assert.doesNotMatch(s, /rm -rf/);
  });

  it("does not propose removing the install of the release line this project declares", () => {
    const r = judgeInstalls(
      facts({
        installs: [node("homebrew", "26.7.0"), node("mise", "18.20.0")],
        winner: { manager: "homebrew", version: "26.7.0", shim: false },
        assess: (v) => (v === "26.7.0" ? good : bad("end of life")),
        projectMajor: 18,
      }),
    );
    assert.equal(r.status, "pass");
  });
});

describe("judgeInstalls: passing and unverified", () => {
  it("passes when the winner is sound and every other install is too", () => {
    const r = judgeInstalls(
      facts({
        installs: [node("mise", "22.23.4"), node("homebrew", "24.13.1")],
        winner: { manager: "mise", version: "22.23.4", shim: false },
        assess: () => good,
      }),
    );
    assert.equal(r.status, "pass");
    assert.match(r.detail, /PATH runs Node 22\.23\.4 \(mise\)/);
    assert.match(r.detail, /2 installs/);
  });

  it("warns when Node is installed but none of it is on PATH", () => {
    const r = judgeInstalls(facts({ winner: null }));
    assert.equal(r.status, "warn");
    assert.match(r.detail, /none is on PATH/);
  });

  it("is unverified when the winner is a shim whose version is not known", () => {
    const r = judgeInstalls(facts({ winner: { manager: "mise", version: null, shim: true } }));
    assert.equal(r.status, "warn");
    assert.notEqual(
      r.didNotRun,
      true,
      "like the runtime row, a warning that --strict counts as did-not-run",
    );
    assert.match(r.detail, /unverified/i);
  });

  it("is unverified, never green, when the release data says unknown", () => {
    const r = judgeInstalls(facts({ assess: () => bad("unknown") }));
    assert.equal(r.status, "warn");
    assert.match(r.detail, /unverified/i);
  });

  it("prints nothing a folder name could use to forge a line", () => {
    const r = judgeInstalls(
      facts({
        installs: [node("mise", "25.8.0", "/x/a\nTRIAGE PASSED"), node("homebrew", "26.7.0")],
      }),
    );
    assert.equal(/[\n\u001b]/.test(r.detail + (r.suggestion ?? "")), false);
  });
});

describe("checkRuntimeInstalls", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    platform: "linux",
    roots: { home: "/h", env: {}, brewPrefixes: [], systemPrefix: "/none" } as InstallRoots,
    inventory: () => [node("mise", "25.8.0"), node("homebrew", "26.7.0")],
    winnerPath: () => "/h/.local/share/mise/installs/node/25.8.0/bin/node",
    realpath: (p: string) => p,
    detectNode: () => ({ declared: null }),
    readInstalled: async () => null,
    lookup: async () => ({ status: "ok", files: [], releases: [], tags: [], errors: [] }) as never,
    assess: (v: string) => (v === "25.8.0" ? bad("end of life") : good),
    online: false,
    ...over,
  });

  it("returns one row built from the winner on PATH and every install", async () => {
    const rows = await checkRuntimeInstalls("/project", deps());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "runtime installs: node");
    assert.equal(rows[0].status, "fail");
  });

  it("returns nothing for a project that does not use Node", async () => {
    const rows = await checkRuntimeInstalls("/project", deps({ detectNode: () => null }));
    assert.deepEqual(rows, []);
  });

  it("says it did not look on Windows, where the manager folders differ and are not verified", async () => {
    const rows = await checkRuntimeInstalls("/project", deps({ platform: "win32" }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "skip");
    assert.match(rows[0].detail, /Windows/);
  });

  it("asks for the version only when the winner is a shim", async () => {
    let asked = 0;
    const rows = await checkRuntimeInstalls(
      "/project",
      deps({
        winnerPath: () => "/h/.local/share/mise/shims/node",
        readInstalled: async () => {
          asked++;
          return "22.23.4";
        },
        assess: () => good,
      }),
    );
    assert.equal(asked, 1);
    assert.equal(rows[0].status, "pass");
  });
});
