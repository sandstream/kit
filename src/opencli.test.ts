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

it("publishes only each auth leaf's supported flags", () => {
  const doc = buildOpenCliDoc();
  for (const [leaf, own] of Object.entries({
    elevate: ["--json", "--list-scopes", "--scope", "--ttl-minutes"],
    status: ["--json"],
    revoke: [],
    "setup-totp": ["--account", "--issuer", "--overwrite"],
  })) {
    const command = doc.commands.auth.commands?.[leaf];
    assert.deepEqual(command?.["x-kit-accepted-flags"], [...own, ...GLOBAL_FLAGS].sort());
    assert.notEqual(command?.["x-kit-flags-inherited"], true);
  }
});

it("advertises the documented governance status alias", () => {
  const command = buildOpenCliDoc().commands.governance;
  assert.equal(command.kind, "group");
  assert.deepEqual(Object.keys(command.commands ?? {}), ["status"]);
});

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

  it("compact flag lists preserve the complete command contract", () => {
    const doc = buildOpenCliDoc();
    assert.deepEqual(JSON.parse(serializeOpenCli(doc)), doc);
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
});

describe("OpenCLI argument metadata", () => {
  const doc = buildOpenCliDoc();

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
      "x-kit-flags-without-values",
      "x-kit-flags-inherited",
    ]);
    const walk = (c: OpenCliDoc["commands"][string]) => {
      for (const k of Object.keys(c)) assert.ok(allowed.has(k), `unexpected command key: ${k}`);
      for (const s of Object.values(c.commands ?? {})) walk(s);
    };
    for (const c of Object.values(doc.commands)) walk(c);
  });
});

describe("OpenCLI command audiences", () => {
  const doc = buildOpenCliDoc();

  // Human commands are interactive setup surfaces. Harness commands are hook protocols.
  // Neither audience belongs on the MCP surface.
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

describe("OpenCLI subcommand flags", () => {
  it("publish own auth flags and inherit other subcommand flags", () => {
    const doc = buildOpenCliDoc();
    let subcommands = 0;
    for (const [name, c] of Object.entries(doc.commands)) {
      for (const [sub, s] of Object.entries(c.commands ?? {})) {
        subcommands++;
        if (name === "auth") {
          // Auth leaves reject each other's flags. Their explicit sets are checked above.
          assert.equal(s["x-kit-flags-inherited"], undefined);
          assert.ok(Array.isArray(s["x-kit-accepted-flags"]));
          assert.ok(Array.isArray(s["x-kit-flags-without-values"]));
          continue;
        }
        assert.equal(s["x-kit-flags-inherited"], true, `${name} ${sub} must mark inheritance`);
        assert.equal(s["x-kit-accepted-flags"], undefined, `${name} ${sub} repeats the list`);
        assert.equal(
          s["x-kit-flags-without-values"],
          undefined,
          `${name} ${sub} repeats value rules`,
        );
      }
    }
    assert.ok(subcommands > 50, "the check saw the subcommands");
  });
});
