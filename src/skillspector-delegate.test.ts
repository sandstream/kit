import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scrubbedEnv,
  stage1Args,
  runSkillspectorStage1,
  skillspectorStatus,
  LLM_ENV_VARS,
  SKILLSPECTOR_BIN,
} from "./skillspector-delegate.js";

describe("SkillSpector static scan configuration", () => {
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
    assert.equal(env.SKILLSPECTOR_PROVIDER, "", "provider cleared");
  });

  it("does not mutate the passed-in base env", () => {
    const base: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-x" };
    scrubbedEnv(base);
    assert.equal(base.OPENAI_API_KEY, "sk-x", "base env untouched");
  });

  it("stage1Args explicitly disables Stage 2 and never enables an LLM/provider", () => {
    const args = stage1Args("./skill");
    assert.deepEqual(args, ["scan", "./skill", "--format", "sarif", "--no-llm"]);
    // The only LLM-related flag is the DISABLING one; nothing enables a provider/model.
    assert.ok(args.includes("--no-llm"));
    assert.ok(!args.includes("--llm"));
    assert.ok(!args.some((a) => /provider|model|openai|anthropic/i.test(a)));
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
