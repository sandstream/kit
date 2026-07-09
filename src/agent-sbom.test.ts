import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentToolchainComponents, mcpServersFromConfig } from "./agent-sbom.js";
import { toCycloneDX, toSpdx, type Component } from "./sbom.js";

describe("agentToolchainComponents", () => {
  it("maps skills / mcp-servers / plugins to components with generic purls + provenance", () => {
    const comps = agentToolchainComponents({
      skills: [{ name: "triage", version: "1.2.0", source: ".claude/skills/triage" }],
      mcpServers: [{ name: "github", source: "npx gh-mcp" }],
      plugins: [{ name: "acme" }],
    });
    const byName = Object.fromEntries(comps.map((c) => [c.name, c]));
    assert.equal(byName.triage.purl, "pkg:generic/skill/triage@1.2.0");
    assert.equal(byName.triage.type, "application");
    assert.equal(byName.triage.provenance, "skill: .claude/skills/triage");
    assert.equal(byName.github.purl, "pkg:generic/mcp-server/github@0.0.0"); // unversioned → 0.0.0
    assert.equal(byName.acme.purl, "pkg:generic/plugin/acme@0.0.0");
  });

  it("dedups by (kind,name,version) and is deterministically sorted", () => {
    const a = agentToolchainComponents({
      skills: [{ name: "x" }, { name: "x" }],
      plugins: [{ name: "a" }],
    });
    assert.equal(a.filter((c) => c.name === "x").length, 1);
    const purls = a.map((c) => c.purl);
    assert.deepEqual(purls, [...purls].sort());
  });

  it("drops nameless entries and returns [] for empty input", () => {
    assert.deepEqual(agentToolchainComponents({}), []);
    assert.deepEqual(agentToolchainComponents({ skills: [{ name: "  " }] }), []);
  });
});

describe("mcpServersFromConfig", () => {
  it("reads mcpServers with command/url as source", () => {
    const s = mcpServersFromConfig({
      mcpServers: {
        gh: { command: "npx", args: ["gh-mcp"] },
        remote: { url: "https://mcp.example.com" },
      },
    });
    const byName = Object.fromEntries(s.map((x) => [x.name, x]));
    assert.equal(byName.gh.source, "npx");
    assert.equal(byName.remote.source, "https://mcp.example.com");
  });
  it("also accepts the `servers` key and tolerates garbage", () => {
    assert.equal(mcpServersFromConfig({ servers: { a: {} } }).length, 1);
    assert.deepEqual(mcpServersFromConfig("nope"), []);
    assert.deepEqual(mcpServersFromConfig({ mcpServers: null }), []);
  });
});

describe("SBOM emitters honor Component.type / purl (backward-compatible)", () => {
  const npm: Component = { name: "lodash", version: "4.17.21" };
  const skill: Component = {
    name: "triage",
    version: "1.0.0",
    type: "application",
    purl: "pkg:generic/skill/triage@1.0.0",
    provenance: "skill: .claude/skills/triage",
  };

  it("CycloneDX: npm stays library+pkg:npm; agent piece carries type+generic purl+provenance", () => {
    const doc = toCycloneDX([npm, skill]) as {
      components: {
        name: string;
        type: string;
        purl: string;
        properties?: { name: string; value: string }[];
      }[];
    };
    const lodash = doc.components.find((c) => c.name === "lodash");
    const triage = doc.components.find((c) => c.name === "triage");
    assert.ok(lodash && triage);
    assert.equal(lodash.type, "library");
    assert.equal(lodash.purl, "pkg:npm/lodash@4.17.21");
    assert.equal(lodash.properties, undefined); // no provenance on plain npm dep
    assert.equal(triage.type, "application");
    assert.equal(triage.purl, "pkg:generic/skill/triage@1.0.0");
    assert.deepEqual(triage.properties, [
      { name: "kit:provenance", value: "skill: .claude/skills/triage" },
    ]);
  });

  it("SPDX: externalRef purl respects the override", () => {
    const doc = toSpdx([skill]) as {
      packages: { externalRefs: { referenceLocator: string }[] }[];
    };
    assert.equal(
      doc.packages[0].externalRefs[0].referenceLocator,
      "pkg:generic/skill/triage@1.0.0",
    );
  });
});
