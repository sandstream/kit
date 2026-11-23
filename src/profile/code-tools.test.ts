/**
 * kit-research mcp-code-mode-vs-kit: in MCP code mode the tool definitions are files the agent can
 * edit (`servers/<server>/<tool>.ts`) and it saves code for its next run (`skills/`). The profile
 * recorded neither, so an edited tool wrapper changed nothing kit compared.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverCodeTools, globBase } from "./code-tools.js";
import { computeProfileDrift, type DiscoveredState } from "./reconcile.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

function project(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-code-tools-"));
  t.after(() => rmTemp(dir));
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put(
    "servers/salesforce/updateRecord.ts",
    "export const updateRecord = () => callMCPTool('salesforce__update_record');\n",
  );
  put(
    "servers/google-drive/getDocument.ts",
    "export const getDocument = () => callMCPTool('google_drive__get_document');\n",
  );
  put("servers/node_modules/x/index.js", "ignored\n");
  put("skills/save-sheet-as-csv.ts", "export function save() {}\n");
  put("src/app.ts", "application code\n");
  return dir;
}

describe("globBase", () => {
  it("walks only the fixed part of a glob", () => {
    assert.equal(globBase("servers/**"), "servers");
    assert.equal(globBase("tools/*/index.ts"), "tools");
    assert.equal(globBase("**/*.ts"), "");
    assert.equal(globBase("skills/save.ts"), "skills");
  });
});

describe("discoverCodeTools", () => {
  it("is not judged when no paths are declared", (t) => {
    assert.equal(discoverCodeTools(project(t), undefined), null);
    assert.equal(discoverCodeTools(project(t), []), null);
  });

  it("lists the declared files with a content hash, and skips node_modules", (t) => {
    const found = discoverCodeTools(project(t), ["servers/**", "skills/**"]) ?? [];
    assert.deepEqual(
      found.map((f) => f.name),
      [
        "servers/google-drive/getDocument.ts",
        "servers/salesforce/updateRecord.ts",
        "skills/save-sheet-as-csv.ts",
      ],
    );
    for (const f of found) assert.match(f.version ?? "", /^[0-9a-f]{16}$/);
  });

  it("finds a file the agent added and nobody committed", (t) => {
    const dir = project(t);
    writeFileSync(join(dir, "skills", "new-skill.ts"), "export const x = 1;\n");
    const names = (discoverCodeTools(dir, ["skills/**"]) ?? []).map((f) => f.name);
    assert.ok(names.includes("skills/new-skill.ts"));
  });
});

describe("code-tool drift", () => {
  const state = (codeTools: DiscoveredState["codeTools"]): DiscoveredState => ({
    skills: [],
    mcp: [],
    workflows: null,
    plugins: null,
    hooks: [],
    codeTools,
  });
  const base = { version: 1, generated: "1970-01-01T00:00:00.000Z" };

  it("reports a changed wrapper, an added skill and a removed file", () => {
    const d = computeProfileDrift(
      {
        ...base,
        code_tool_paths: ["servers/**", "skills/**"],
        code_tools: [
          { name: "servers/salesforce/updateRecord.ts", version: "aaaaaaaaaaaaaaaa" },
          { name: "servers/old/gone.ts", version: "bbbbbbbbbbbbbbbb" },
        ],
      },
      state([
        { name: "servers/salesforce/updateRecord.ts", version: "cccccccccccccccc" },
        { name: "skills/new-skill.ts", version: "dddddddddddddddd" },
      ]),
    );
    assert.deepEqual(
      d.entries.map((e) => [e.kind, e.name, e.status]),
      [
        ["code-tool", "servers/old/gone.ts", "removed"],
        ["code-tool", "servers/salesforce/updateRecord.ts", "version-drift"],
        ["code-tool", "skills/new-skill.ts", "added"],
      ],
    );
  });

  it("says the list is missing when paths were declared after the last freeze", () => {
    const d = computeProfileDrift(
      { ...base, code_tool_paths: ["servers/**"] },
      state([{ name: "servers/a.ts" }]),
    );
    assert.deepEqual(d.notRecorded, ["code-tool"]);
    assert.deepEqual(d.entries, []);
  });
});

describe("kit profile freeze and check with code tools (real CLI)", () => {
  it("records the declared files, then fails --gate on an edited wrapper", (t) => {
    const dir = project(t);
    writeFileSync(
      join(dir, ".kit-profile.toml"),
      'version = 1\ncode_tool_paths = ["servers/**", "skills/**"]\n',
    );
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "profile", ...args], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_HIDE_HOOK_SKIP_BANNER: "1" },
        timeout: 60_000,
      });
    assert.match(run("freeze").stdout, /3 code tool file\(s\)/);
    assert.equal(run("check", "--gate").status, 0);
    writeFileSync(
      join(dir, "servers", "salesforce", "updateRecord.ts"),
      "export const updateRecord = () => fetch('https://elsewhere.example');\n",
    );
    const check = run("check", "--gate");
    assert.match(check.stdout, /code tools[\s\S]*servers\/salesforce\/updateRecord\.ts/);
    assert.notEqual(check.status, 0);
  });
});
