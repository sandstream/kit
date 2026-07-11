import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scrubbedEnv,
  stage1Args,
  normalizeSkillspectorSarif,
  runSkillspectorStage1,
  skillspectorStatus,
  LLM_ENV_VARS,
  SKILLSPECTOR_SOURCE,
  SKILLSPECTOR_BIN,
} from "./skillspector-delegate.js";

// A minimal SkillSpector-style SARIF 2.1.0 log with one HIGH finding.
const SARIF = JSON.stringify({
  runs: [
    {
      tool: {
        driver: {
          name: "SkillSpector",
          rules: [
            {
              id: "SC4-curl-bash",
              properties: { "security-severity": "8.1", tags: ["supply-chain"] },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "SC4-curl-bash",
          level: "error",
          message: { text: "pipes curl into bash" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "install.sh" },
                region: { startLine: 3 },
              },
            },
          ],
        },
      ],
    },
  ],
});

describe("skillspector delegate — zero-LLM enforcement (no egress)", () => {
  it("scrubbedEnv strips every provider API key and SKILLSPECTOR_* var", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-should-be-gone",
      ANTHROPIC_API_KEY: "sk-ant-gone",
      SKILLSPECTOR_PROVIDER: "openai",
      SKILLSPECTOR_MODEL: "gpt-5.4",
      HOME: "/home/x",
    };
    const env = scrubbedEnv(base);
    assert.equal(env.PATH, "/usr/bin", "innocuous vars survive");
    assert.equal(env.HOME, "/home/x");
    for (const k of LLM_ENV_VARS) assert.equal(env[k], undefined, `${k} must be stripped`);
    assert.equal(env.SKILLSPECTOR_MODEL, undefined, "SKILLSPECTOR_* stripped");
    assert.equal(env.SKILLSPECTOR_PROVIDER, "", "provider pinned empty (no network default)");
  });

  it("does not mutate the passed-in base env", () => {
    const base: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-x" };
    scrubbedEnv(base);
    assert.equal(base.OPENAI_API_KEY, "sk-x", "base env untouched");
  });

  it("stage1Args never contains an LLM/provider flag", () => {
    const args = stage1Args("./skill");
    assert.deepEqual(args, ["scan", "./skill", "--format", "sarif"]);
    assert.ok(!args.some((a) => /llm|provider|model|openai|anthropic/i.test(a)));
  });
});

describe("skillspector delegate — SARIF normalization (attributed)", () => {
  it("maps SARIF findings to supply-chain kit findings tagged with the source", () => {
    const findings = normalizeSkillspectorSarif(SARIF);
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.category, "supply-chain");
    assert.equal(f.status, "fail");
    assert.equal(f.severity, "high", "CVSS 8.1 → high");
    assert.ok(f.name.startsWith(SKILLSPECTOR_SOURCE), `attributed: ${f.name}`);
    assert.match(f.detail, /curl into bash/);
    assert.match(f.detail, /install\.sh/);
  });

  it("returns [] for empty or invalid SARIF (never throws)", () => {
    assert.deepEqual(normalizeSkillspectorSarif(""), []);
    assert.deepEqual(normalizeSkillspectorSarif("not json"), []);
    assert.deepEqual(normalizeSkillspectorSarif(JSON.stringify({ runs: [] })), []);
  });
});

describe("skillspector delegate — fail-closed when the binary is absent", () => {
  it("returns unavailable (not a silent pass) when skillspector is not installed", async () => {
    // skillspector is not installed in CI → resolveToolBin returns null.
    const r = await runSkillspectorStage1("./skill");
    assert.equal(r.status, "unavailable");
    if (r.status === "unavailable") assert.match(r.detail, new RegExp(SKILLSPECTOR_BIN));
  });

  it("skillspectorStatus reports not-available when the binary is absent", async () => {
    const s = await skillspectorStatus();
    assert.equal(s.available, false);
    assert.match(s.detail, new RegExp(SKILLSPECTOR_BIN));
  });
});
