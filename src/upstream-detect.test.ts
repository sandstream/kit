import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { validateUpstreamCatalog } from "./upstream-catalog.js";
import { detectUpstreamServices, loadUpstreamInputs } from "./upstream-detect.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const catalog = validateUpstreamCatalog([
  {
    id: "convex",
    label: "Convex",
    npm: ["convex"],
    github: ["convex/convex-js"],
    kitServices: ["convex"],
  },
  {
    id: "stripe",
    label: "Stripe",
    npm: ["stripe"],
    github: ["stripe/stripe-node"],
    kitServices: ["stripe"],
  },
]);

describe("detectUpstreamServices (pure)", () => {
  it("finds a service through a package.json dependency", () => {
    const found = detectUpstreamServices({
      catalog,
      kitServices: [],
      manifests: [{ path: "package.json", dependencies: { convex: "^1.45.0", react: "^19" } }],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "convex");
    assert.deepEqual(found[0].evidence, [
      { kind: "package-json", source: "package.json", name: "convex", declared: "^1.45.0" },
    ]);
  });

  it("finds a service through [services.*] in .kit.toml", () => {
    const found = detectUpstreamServices({ catalog, kitServices: ["stripe"], manifests: [] });
    assert.deepEqual(
      found.map((f) => f.id),
      ["stripe"],
    );
    assert.equal(found[0].evidence[0].kind, "kit-toml");
  });

  it("merges evidence from several manifests into one service", () => {
    const found = detectUpstreamServices({
      catalog,
      kitServices: ["convex"],
      manifests: [
        { path: "package.json", dependencies: { convex: "^1.45.0" } },
        { path: "web/package.json", dependencies: { convex: "^1.44.0" } },
      ],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].evidence.length, 3);
  });

  it("returns services sorted by id and ignores unknown packages", () => {
    const found = detectUpstreamServices({
      catalog,
      kitServices: [],
      manifests: [
        { path: "package.json", dependencies: { stripe: "^14", convex: "^1", lodash: "^4" } },
      ],
    });
    assert.deepEqual(
      found.map((f) => f.id),
      ["convex", "stripe"],
    );
  });

  it("does not match a package that only shares a prefix", () => {
    const found = detectUpstreamServices({
      catalog,
      kitServices: [],
      manifests: [
        { path: "package.json", dependencies: { "convex-helpers": "^1", stripe2: "^1" } },
      ],
    });
    assert.deepEqual(found, []);
  });
});

describe("loadUpstreamInputs (filesystem, no network)", () => {
  function inTempDir(files: Record<string, string>, body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "kit-upstream-"));
    try {
      for (const [file, text] of Object.entries(files)) {
        const full = join(dir, file);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
      body(dir);
    } finally {
      rmTemp(dir);
    }
  }

  it("reads the root package.json, a web/ subfolder and workspace packages", () =>
    inTempDir(
      {
        "package.json": JSON.stringify({ dependencies: { convex: "^1.45.0" } }),
        "web/package.json": JSON.stringify({ devDependencies: { stripe: "^14" } }),
        "packages/app/package.json": JSON.stringify({ dependencies: { stripe: "^13" } }),
        "node_modules/convex/package.json": JSON.stringify({ dependencies: { stripe: "^1" } }),
      },
      (dir) => {
        const inputs = loadUpstreamInputs(dir);
        assert.deepEqual(
          inputs.manifests.map((m) => m.path),
          ["package.json", "packages/app/package.json", "web/package.json"],
        );
      },
    ));

  it("reads service names and the [upstream] table from .kit.toml", () =>
    inTempDir(
      {
        ".kit.toml": [
          "[services.stripe]",
          'check = "stripe --version"',
          "",
          "[upstream.acme]",
          'npm = ["acme-sdk"]',
        ].join("\n"),
      },
      (dir) => {
        const inputs = loadUpstreamInputs(dir);
        assert.deepEqual(inputs.kitServices, ["stripe"]);
        assert.equal(inputs.upstream?.acme !== undefined, true);
      },
    ));

  it("skips an unreadable package.json and says so", () =>
    inTempDir({ "package.json": "{ not json", "web/package.json": "{}" }, (dir) => {
      const inputs = loadUpstreamInputs(dir);
      assert.deepEqual(
        inputs.manifests.map((m) => m.path),
        ["web/package.json"],
      );
      assert.deepEqual(
        inputs.skipped.map((s) => s.path),
        ["package.json"],
      );
    }));

  it("reports a malformed .kit.toml instead of treating it as empty", () =>
    inTempDir({ ".kit.toml": "[services\n" }, (dir) => {
      const inputs = loadUpstreamInputs(dir);
      assert.deepEqual(inputs.kitServices, []);
      assert.equal(
        inputs.skipped.some((s) => s.path === ".kit.toml"),
        true,
      );
    }));

  it("returns empty inputs for a directory with nothing in it", () =>
    inTempDir({}, (dir) => {
      const inputs = loadUpstreamInputs(dir);
      assert.deepEqual(inputs, {
        kitServices: [],
        upstream: undefined,
        manifests: [],
        skipped: [],
      });
    }));
});

describe("untrusted repository content", () => {
  it("does not follow a symlinked .kit.toml and does not echo a broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-upstream-safe-"));
    try {
      writeFileSync(join(dir, "secret.txt"), "TOP-SECRET-VALUE");
      symlinkSync(join(dir, "secret.txt"), join(dir, ".kit.toml"));
      const linked = loadUpstreamInputs(dir);
      assert.deepEqual(linked.kitServices, []);
      assert.match(linked.skipped[0]?.reason ?? "", /symlink/);
      assert.ok(!JSON.stringify(linked).includes("TOP-SECRET-VALUE"));

      rmTemp(join(dir, ".kit.toml"));
      writeFileSync(join(dir, ".kit.toml"), 'token = "TOP-SECRET-VALUE" nope');
      writeFileSync(join(dir, "package.json"), '{ "x": "TOP-SECRET-VALUE" nope');
      const broken = loadUpstreamInputs(dir);
      assert.equal(broken.skipped.length, 2);
      assert.ok(!JSON.stringify(broken).includes("TOP-SECRET-VALUE"));
    } finally {
      rmTemp(dir);
    }
  });

  it("skips a folder whose name carries terminal control characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-upstream-safe-"));
    try {
      const evil = `web${String.fromCharCode(27)}[2J`;
      mkdirSync(join(dir, evil), { recursive: true });
      writeFileSync(join(dir, evil, "package.json"), "{}");
      writeFileSync(join(dir, "package.json"), "{}");
      assert.deepEqual(
        loadUpstreamInputs(dir).manifests.map((m) => m.path),
        ["package.json"],
      );
    } finally {
      rmTemp(dir);
    }
  });
});
