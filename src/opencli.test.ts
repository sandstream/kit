import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenCliDoc, serializeOpenCli, OPENCLI_VERSION, type OpenCliDoc } from "./opencli.js";

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

  it("never fabricates args/flags — every node marks args unmodeled", () => {
    const nodes: { "x-kit-args-modeled": boolean }[] = [];
    for (const c of Object.values(doc.commands)) {
      nodes.push(c);
      for (const s of Object.values(c.commands ?? {})) nodes.push(s);
    }
    assert.ok(nodes.length > 0);
    assert.ok(
      nodes.every((n) => n["x-kit-args-modeled"] === false),
      "until the registry models args/flags, all nodes must declare them unmodeled",
    );
  });

  it("only x-kit-* extension keys are used alongside spec fields (honest namespacing)", () => {
    const allowed = new Set([
      "kind",
      "summary",
      "commands",
      "x-kit-stability",
      "x-kit-mcp",
      "x-kit-args-modeled",
    ]);
    const walk = (c: OpenCliDoc["commands"][string]) => {
      for (const k of Object.keys(c)) assert.ok(allowed.has(k), `unexpected command key: ${k}`);
      for (const s of Object.values(c.commands ?? {})) walk(s);
    };
    for (const c of Object.values(doc.commands)) walk(c);
  });
});
