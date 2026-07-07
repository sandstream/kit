import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEnvFile, decideEnvWriteGate, extractWriteFromHookPayload } from "./env-write-gate.js";

// A realistic AWS access key id + secret (fake values, valid shapes) that kit's
// SECRET_PATTERNS match — the same detector `kit check`'s plaintext scan uses.
const AWS_LINE = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
const GH_LINE = "GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a1234";

describe("env-write-gate — isEnvFile", () => {
  it("matches real env files anywhere in the tree", () => {
    for (const p of [".env", ".env.local", ".env.production", ".envrc", "apps/web/.env"]) {
      assert.equal(isEnvFile(p), true, p);
    }
  });
  it("exempts template/example variants and non-env files", () => {
    for (const p of [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      "src/index.ts",
      "environment.ts",
      "README.md",
    ]) {
      assert.equal(isEnvFile(p), false, p);
    }
  });
});

describe("env-write-gate — decideEnvWriteGate", () => {
  it("BLOCKS a secret-pattern hit written to a real env file", () => {
    const v = decideEnvWriteGate("/repo/.env", `${AWS_LINE}\n${GH_LINE}\n`);
    assert.equal(v.block, true);
    assert.match(v.reason ?? "", /\.env/);
  });
  it("allows placeholders and empty values in env files", () => {
    const v = decideEnvWriteGate(
      "/repo/.env.local",
      "API_KEY=\nDATABASE_URL=changeme\nDEBUG=true\n",
    );
    assert.equal(v.block, false);
  });
  it("allows secrets aimed at template files (placeholders belong there)", () => {
    assert.equal(decideEnvWriteGate("/repo/.env.example", AWS_LINE).block, false);
  });
  it("never blocks non-env files even with secret-shaped content", () => {
    assert.equal(decideEnvWriteGate("/repo/src/fixture.test.ts", AWS_LINE).block, false);
  });
  it("allows empty/missing input", () => {
    assert.equal(decideEnvWriteGate("", AWS_LINE).block, false);
    assert.equal(decideEnvWriteGate("/repo/.env", "").block, false);
  });
});

describe("env-write-gate — extractWriteFromHookPayload", () => {
  it("extracts Write payloads (file_path + content)", () => {
    const w = extractWriteFromHookPayload({
      tool_name: "Write",
      tool_input: { file_path: "/repo/.env", content: AWS_LINE },
    });
    assert.deepEqual(w, { filePath: "/repo/.env", text: AWS_LINE });
  });
  it("extracts Edit payloads (new_string) and MultiEdit edits[]", () => {
    const edit = extractWriteFromHookPayload({
      tool_input: { file_path: "/repo/.env", new_string: GH_LINE },
    });
    assert.equal(edit?.text, GH_LINE);
    const multi = extractWriteFromHookPayload({
      tool_input: {
        file_path: "/repo/.env",
        edits: [{ new_string: "A=1" }, { new_string: GH_LINE }],
      },
    });
    assert.ok(multi?.text.includes(GH_LINE));
  });
  it("returns null for non-write payloads (→ allow)", () => {
    assert.equal(extractWriteFromHookPayload({ tool_input: { command: "ls" } }), null);
    assert.equal(extractWriteFromHookPayload({}), null);
    assert.equal(extractWriteFromHookPayload(null), null);
    // a Read of an env file has file_path but writes no text → allow
    assert.equal(extractWriteFromHookPayload({ tool_input: { file_path: "/repo/.env" } }), null);
  });
});
