import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenCliDoc, serializeOpenCli, OPENCLI_VERSION, type OpenCliDoc } from "./opencli.js";
import { COMMAND_FLAGS } from "./flag-surface.js";
import { GLOBAL_FLAGS } from "./utils/flags.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/opencli.test.js -> repo root is one level up.
const SNAPSHOT_PATH = join(__dirname, "..", "contracts", "kit.opencli.json");

describe("OpenCLI document snapshot", () => {
  it("regenerates identically to the committed contracts/kit.opencli.json", () => {
    const committed = readFileSync(SNAPSHOT_PATH, "utf-8");
    const live = serializeOpenCli(buildOpenCliDoc());
    assert.equal(
      live,
      committed,
      [
        "OpenCLI document drifted from contracts/kit.opencli.json.",
        "If this command-surface change is intentional:",
        "  1. Review the diff above.",
        "  2. Run `npm run build && node scripts/gen-opencli.mjs` to regenerate.",
        "  3. Commit the updated contracts/kit.opencli.json.",
      ].join("\n"),
    );
  });

  it("serialization is deterministic (stable across repeated builds)", () => {
    assert.equal(serializeOpenCli(buildOpenCliDoc()), serializeOpenCli(buildOpenCliDoc()));
  });
});

describe("OpenCLI document shape", () => {
  const doc = buildOpenCliDoc();

  it("carries the targeted spec version + kit info", () => {
    assert.equal(doc.opencliVersion, OPENCLI_VERSION);
    assert.equal(doc.info.binary, "kit");
    assert.equal(doc.info.title, "kit");
    assert.match(doc.info.version, /^\d+\./);
  });

  it("mirrors the command surface (check is a stable, MCP-exposed command)", () => {
    const check = doc.commands.check;
    assert.ok(check, "check command present");
    assert.equal(check["x-kit-stability"], "stable");
    assert.equal(check["x-kit-mcp"], true);
  });

  it("promotes a verb with subcommands to a group and nests them", () => {
    const airgap = doc.commands.airgap;
    assert.equal(airgap?.kind, "group");
    assert.ok(airgap.commands?.verify, "airgap verify nested under the group");
    assert.equal(airgap.commands.verify.kind, "command");
  });

  it("publishes accepted flag names from the generated flag surface", () => {
    const check = doc.commands.check;
    assert.equal(check?.["x-kit-args-modeled"], true);
    assert.deepEqual(
      check?.["x-kit-accepted-flags"],
      [...new Set([...COMMAND_FLAGS.check, ...GLOBAL_FLAGS])].sort(),
    );
    assert.ok(check?.["x-kit-accepted-flags"]?.includes("--category"));
    assert.ok(check?.["x-kit-accepted-flags"]?.includes("--read-only"));
  });

  it("marks every tabled command and subcommand as modeled", () => {
    for (const [name, c] of Object.entries(doc.commands)) {
      assert.equal(c["x-kit-args-modeled"], true, `${name} must expose accepted flag names`);
      assert.ok(Array.isArray(c["x-kit-accepted-flags"]), `${name} must carry a flag list`);
      for (const [sub, s] of Object.entries(c.commands ?? {})) {
        assert.equal(s["x-kit-args-modeled"], true, `${name} ${sub} must inherit parent flags`);
        assert.deepEqual(s["x-kit-accepted-flags"], c["x-kit-accepted-flags"]);
      }
    }
  });

  it("does not fabricate OpenCLI arg/flag type metadata", () => {
    const nodes: object[] = [];
    for (const c of Object.values(doc.commands)) {
      nodes.push(c);
      for (const s of Object.values(c.commands ?? {})) nodes.push(s);
    }
    assert.ok(nodes.length > 0);
    for (const n of nodes) {
      assert.equal("args" in n, false);
      assert.equal("flags" in n, false);
    }
  });

  it("only x-kit-* extension keys are used alongside spec fields (honest namespacing)", () => {
    const allowed = new Set([
      "kind",
      "summary",
      "commands",
      "x-kit-stability",
      "x-kit-mcp",
      "x-kit-audience",
      "x-kit-args-modeled",
      "x-kit-accepted-flags",
    ]);
    const walk = (c: OpenCliDoc["commands"][string]) => {
      for (const k of Object.keys(c)) assert.ok(allowed.has(k), `unexpected command key: ${k}`);
      for (const s of Object.values(c.commands ?? {})) walk(s);
    };
    for (const c of Object.values(doc.commands)) walk(c);
  });

  // Audience ↔ MCP consistency: the exposure layer must respect the audience
  // annotation. "human" commands are interactive/setup surfaces — they do not
  // belong on the MCP surface; "harness" commands are hook stdin protocols —
  // they belong on NO discovery surface. 6.0 removed the last tolerated
  // overlap (the deprecated setup-time tools), so this is now exception-free.
  it("audience: human/harness commands are never MCP-exposed", () => {
    const offenders: string[] = [];
    for (const [name, c] of Object.entries(doc.commands)) {
      const audience = c["x-kit-audience"];
      if ((audience === "human" || audience === "harness") && c["x-kit-mcp"]) {
        offenders.push(`${name} (${audience})`);
      }
    }
    assert.deepEqual(offenders, [], "human/harness-audience commands must not be MCP-exposed");
  });

  it("every command carries a valid audience", () => {
    const valid = new Set(["human", "agent", "harness", "all"]);
    const walk = (name: string, c: OpenCliDoc["commands"][string]) => {
      assert.ok(valid.has(c["x-kit-audience"]), `${name}: invalid audience ${c["x-kit-audience"]}`);
      for (const [sub, s] of Object.entries(c.commands ?? {})) walk(`${name} ${sub}`, s);
    };
    for (const [name, c] of Object.entries(doc.commands)) walk(name, c);
  });
});
