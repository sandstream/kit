import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { collectReview, REVIEW_STAGES } from "./commands/review.js";

const source = import.meta.url.endsWith(".ts");
const extension = source ? "ts" : "js";
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
const cli = new URL(`./cli.${extension}`, import.meta.url).href;
const mcp = new URL(`./mcp-server.${extension}`, import.meta.url).href;

function fixture(): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "kit-review-invalid-cwd-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, ".kit.toml"), "invalid TOML [\n");
  writeFileSync(join(root, "file"), "not a directory\n");
  return {
    root,
    env: {
      HOME: join(root, "home"),
      PATH: join(root, "bin"),
      KIT_IDENTITY_DIR: join(root, "home", "identity"),
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_AIRGAP: "1",
    },
  };
}

function assertDirectoryError(text: string, cwd: string): void {
  assert.match(text, /review.*directory/i);
  assert.ok(text.includes(cwd), `error must identify requested directory: ${text}`);
  assert.doesNotMatch(text, /Invalid \.kit\.toml|review passed|"ok":\s*true/);
}

describe("review rejects invalid cwd before any stage", () => {
  for (const path of ["missing", "file", "file/child"]) {
    for (const stages of [...REVIEW_STAGES.map((stage) => [stage]), [], undefined]) {
      it(`collector refuses ${path}, stages=${JSON.stringify(stages)}`, async () => {
        const { root } = fixture();
        const cwd = join(root, path);
        try {
          await assert.rejects(collectReview({ cwd, stages }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assertDirectoryError(error.message, cwd);
            return true;
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("kit_review rejects invalid requested cwd over MCP", () => {
  for (const path of ["missing", "file", "file/child"]) {
    for (const stage of ["check", "design", "standards", "adr"]) {
      it(`refuses ${path}, stages=[${stage}]`, async () => {
        const { root, env } = fixture();
        const cwd = join(root, path);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            ...loader,
            "--input-type=module",
            "-e",
            `const { startMcpServer } = await import(${JSON.stringify(mcp)}); await startMcpServer();`,
          ],
          cwd: root,
          env,
          stderr: "pipe",
        });
        const client = new Client({ name: "review-cwd-test", version: "1" });
        try {
          await client.connect(transport);
          const result = await client.callTool({
            name: "kit_review",
            arguments: { cwd, stages: [stage] },
          });
          assert.equal(result.isError, true, JSON.stringify(result));
          assert.ok(Array.isArray(result.content));
          const messages: string[] = [];
          for (const item of result.content) {
            if (
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "text" &&
              "text" in item &&
              typeof item.text === "string"
            ) {
              messages.push(item.text);
            }
          }
          assertDirectoryError(messages.join("\n"), cwd);
        } finally {
          await client.close();
          await transport.close();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

it(
  "CLI review names a removed working directory before loading config",
  {
    skip:
      process.platform === "win32" ? "Windows cannot remove a process's current directory" : false,
  },
  () => {
    const { root, env } = fixture();
    const cwd = join(root, "removed");
    mkdirSync(cwd);
    try {
      const script = `
      import { rmSync } from "node:fs";
      process.chdir(${JSON.stringify(cwd)});
      process.cwd();
      rmSync(${JSON.stringify(cwd)}, { recursive: true });
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, "review", "--stages", "adr", "--json"];
      await import(${JSON.stringify(cli)});
    `;
      const result = spawnSync(process.execPath, [...loader, "--input-type=module", "-e", script], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assertDirectoryError(result.stderr + result.stdout, cwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
