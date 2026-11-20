import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyseGraph } from "./dependency-surface.js";
import {
  graphFromPnpmLock,
  parseYamlSubset,
  pnpmLockfileVersion,
} from "./dependency-surface-pnpm.js";

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      big:
        specifier: ^1.0.0
        version: 1.0.2
    devDependencies:
      tool:
        specifier: ^3.0.0
        version: 3.0.0(peer-x@1.0.0)

packages:

  '@scope/x@2.0.0':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=14'}

  alias-target@4.0.0:
    resolution: {integrity: sha512-alias}

  big-a@1.1.0:
    resolution: {integrity: sha512-bbb}

  big@1.0.2:
    resolution: {integrity: sha512-ccc, tarball: https://example.test/big-1.0.2.tgz}
    engines: {node: '>=18'}

  native@1.0.0:
    resolution: {integrity: sha512-ddd}
    cpu: [arm64]
    os: [darwin]
    requiresBuild: true

  peer-x@1.0.0:
    resolution: {integrity: sha512-eee}

  shared@1.0.0:
    resolution: {integrity: sha512-fff}

  tool-a@1.0.0:
    resolution: {integrity: sha512-ggg}
    hasBin: true

  tool@3.0.0:
    resolution: {integrity: sha512-hhh}
    peerDependencies:
      peer-x: ^1.0.0

snapshots:

  '@scope/x@2.0.0': {}

  alias-target@4.0.0: {}

  big-a@1.1.0:
    dependencies:
      shared: 1.0.0

  big@1.0.2:
    dependencies:
      big-a: 1.1.0
      '@scope/x': 2.0.0
      aliased: alias-target@4.0.0
    optionalDependencies:
      native: 1.0.0

  native@1.0.0:
    optional: true

  peer-x@1.0.0: {}

  shared@1.0.0: {}

  tool-a@1.0.0: {}

  tool@3.0.0(peer-x@1.0.0):
    dependencies:
      tool-a: 1.0.0
      shared: 1.0.0
      peer-x: 1.0.0
`;

const MANIFEST = {
  dependencies: { big: "^1.0.0" },
  devDependencies: { tool: "^3.0.0" },
};

describe("parseYamlSubset", () => {
  it("reads nested maps, quoted keys, flow maps and flow lists, and ignores comments", () => {
    const tree = parseYamlSubset(
      [
        "# a comment",
        "a:",
        "  'b@1.0.0(c@2)':",
        "    x: {k: v, u: 'w z'}",
        "    y: [one, two]",
        "  d: e # trailing",
        "f: {}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(tree, {
      a: { "b@1.0.0(c@2)": { x: { k: "v", u: "w z" }, y: ["one", "two"] }, d: "e" },
      f: {},
    });
  });

  it("keeps a colon inside a flow value, such as a URL", () => {
    const tree = parseYamlSubset("r: {tarball: https://example.test/x.tgz, integrity: sha512-a}\n");
    assert.deepEqual(tree, { r: { tarball: "https://example.test/x.tgz", integrity: "sha512-a" } });
  });
});

describe("pnpmLockfileVersion", () => {
  it("returns the version of a pnpm lockfile and null for anything else", () => {
    assert.equal(pnpmLockfileVersion(LOCK), "9.0");
    assert.equal(pnpmLockfileVersion("# yarn lockfile v1\n"), null);
    assert.equal(pnpmLockfileVersion(""), null);
  });
});

describe("graphFromPnpmLock", () => {
  const graph = graphFromPnpmLock(LOCK, MANIFEST);

  it("reads a lockfile of format 9 and refuses other text and other formats", () => {
    assert.ok(graph);
    assert.equal(graphFromPnpmLock("# yarn lockfile v1\n", MANIFEST), null);
    assert.equal(graphFromPnpmLock(LOCK.replace("'9.0'", "'6.0'"), MANIFEST), null);
  });

  it("resolves each direct dependency to the snapshot the importer names", () => {
    assert.equal(graph?.direct.get("big"), "big@1.0.2");
    assert.equal(graph?.direct.get("tool"), "tool@3.0.0(peer-x@1.0.0)");
  });

  it("gives a package its name and version without the peer suffix", () => {
    const node = graph?.nodes.get("tool@3.0.0(peer-x@1.0.0)");
    assert.equal(node?.name, "tool");
    assert.equal(node?.version, "3.0.0");
    assert.equal(graph?.nodes.get("@scope/x@2.0.0")?.name, "@scope/x");
  });

  it("follows dependencies, optional dependencies and aliases", () => {
    const deps = [...(graph?.nodes.get("big@1.0.2")?.deps ?? [])].sort();
    assert.deepEqual(deps, ["@scope/x@2.0.0", "alias-target@4.0.0", "big-a@1.1.0", "native@1.0.0"]);
  });

  it("marks as development only what no runtime dependency reaches", () => {
    const dev = (id: string) => graph?.nodes.get(id)?.dev;
    assert.equal(dev("big@1.0.2"), false);
    assert.equal(dev("shared@1.0.0"), false, "reached from a runtime dependency too");
    assert.equal(dev("tool@3.0.0(peer-x@1.0.0)"), true);
    assert.equal(dev("tool-a@1.0.0"), true);
    assert.equal(dev("peer-x@1.0.0"), true);
  });

  it("reads engines, install scripts and platform-only packages from the lockfile", () => {
    assert.equal(graph?.nodes.get("big@1.0.2")?.engines, ">=18");
    assert.equal(graph?.nodes.get("big-a@1.1.0")?.engines, undefined);
    const native = graph?.nodes.get("native@1.0.0");
    assert.equal(native?.hasInstallScript, true);
    assert.equal(native?.platformOnly, true);
    assert.equal(graph?.nodes.get("big@1.0.2")?.hasInstallScript, false);
    assert.equal(graph?.nodes.get("big@1.0.2")?.platformOnly, false);
  });

  it("says which fact it cannot give", () => {
    assert.deepEqual(graph?.cannotSee, ["bin names"]);
  });

  it("feeds the same analysis as the other lockfiles", () => {
    assert.ok(graph);
    const report = analyseGraph({
      graph,
      manifest: MANIFEST,
      usage: { importSites: new Map(), scriptText: "" },
    });
    assert.equal(report.totals.direct, 2);
    const big = report.direct.find((d) => d.name === "big");
    // big brings big-a, shared, @scope/x, alias-target, native; shared is also needed by tool.
    assert.equal(big?.brings, 5);
    assert.equal(big?.onlyThrough, 4);
  });

  it("drops the importers of other workspace members from the count", () => {
    const multi = LOCK.replace(
      "packages:",
      `  packages/other:
    dependencies:
      shared:
        specifier: ^1.0.0
        version: 1.0.0

packages:`,
    );
    const g = graphFromPnpmLock(multi, MANIFEST);
    assert.equal(g?.direct.size, 2);
  });
});
