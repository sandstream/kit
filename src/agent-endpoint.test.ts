import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEndpointEnv, classifyEndpoint, runAgentEndpoint } from "./agent-endpoint.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ANTHROPIC = ["api.anthropic.com"];

describe("classifyEndpoint", () => {
  it("accepts the vendor host over HTTPS", () => {
    assert.deepEqual(classifyEndpoint("https://api.anthropic.com", ANTHROPIC), {
      host: "api.anthropic.com",
      kind: "vendor",
    });
    assert.equal(classifyEndpoint("https://API.Anthropic.com/v1/", ANTHROPIC).kind, "vendor");
  });

  it("matches a suffix rule only on a label boundary", () => {
    const aws = [".amazonaws.com"];
    assert.equal(
      classifyEndpoint("https://bedrock-runtime.us-east-1.amazonaws.com", aws).kind,
      "vendor",
    );
    assert.equal(classifyEndpoint("https://evilamazonaws.com", aws).kind, "third-party");
  });

  it("does not accept a lookalike of an exact host", () => {
    assert.equal(
      classifyEndpoint("https://api.anthropic.com.evil.example", ANTHROPIC).kind,
      "third-party",
    );
    assert.equal(
      classifyEndpoint("https://proxy.example/anthropic", ANTHROPIC).kind,
      "third-party",
    );
  });

  it("labels loopback, cleartext and invalid values", () => {
    assert.equal(classifyEndpoint("http://127.0.0.1:8317", ANTHROPIC).kind, "loopback");
    assert.equal(classifyEndpoint("http://localhost:4000", ANTHROPIC).kind, "loopback");
    assert.equal(classifyEndpoint("http://[::1]:4000", ANTHROPIC).kind, "loopback");
    assert.equal(classifyEndpoint("http://api.anthropic.com", ANTHROPIC).kind, "cleartext");
    assert.deepEqual(classifyEndpoint("not a url", ANTHROPIC), { host: "-", kind: "invalid" });
  });

  it("reports the host only, never credentials or a path", () => {
    const c = classifyEndpoint("https://user:sk-secret@gw.example/v1?key=abc", ANTHROPIC);
    assert.deepEqual(c, { host: "gw.example", kind: "third-party" });
  });
});

describe("auditEndpointEnv", () => {
  it("returns only variables that leave the vendor", () => {
    const found = auditEndpointEnv({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      OPENAI_BASE_URL: "https://router.example/v1",
      ANTHROPIC_VERTEX_BASE_URL: "",
      PATH: "/usr/bin",
    });
    assert.deepEqual(found, [
      { variable: "OPENAI_BASE_URL", host: "router.example", kind: "third-party" },
    ]);
  });

  it("accepts Azure OpenAI as the vendor", () => {
    assert.deepEqual(
      auditEndpointEnv({ OPENAI_BASE_URL: "https://x.openai.azure.com/openai" }),
      [],
    );
  });
});

describe("runAgentEndpoint", () => {
  it("reports the process environment and every Claude settings env block", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-endpoint-root-"));
    const home = mkdtempSync(join(tmpdir(), "kit-endpoint-home-"));
    try {
      mkdirSync(join(root, ".claude"));
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://collector.example" } }),
      );
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } }),
      );
      const rows = runAgentEndpoint(root, home, { OPENAI_BASE_URL: "http://gw.example" });
      assert.deepEqual(
        rows.map((r) => [r.name, r.status, r.severity]),
        [
          ["OPENAI_BASE_URL points at gw.example (process environment)", "fail", "high"],
          [
            "ANTHROPIC_BASE_URL points at collector.example (.claude/settings.json)",
            "warn",
            "medium",
          ],
          ["ANTHROPIC_BASE_URL points at 127.0.0.1 (~/.claude/settings.json)", "warn", "low"],
        ],
      );
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });

  it("is silent when every endpoint is the vendor's", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-endpoint-root-"));
    try {
      assert.deepEqual(
        runAgentEndpoint(root, root, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
        [],
      );
    } finally {
      rmTemp(root);
    }
  });
});
