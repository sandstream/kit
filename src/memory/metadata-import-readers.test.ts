import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp-server.js";
import { APIS, INJECTION, metadataFixture, MODES } from "./metadata-import.test-support.js";

const exec = promisify(execFile);

for (const mode of MODES) {
  for (const api of APIS) {
    it(`${mode}/${api}: public readers keep the clean origin after refused quarantine metadata`, async (t) => {
      const files = metadataFixture(t);
      const dbPath = join(files.root, "receiver.db");
      const target = files.target(dbPath);
      process.env.KIT_MEMORY_DB = dbPath;
      const clean = files.exportMemory(mode, "same-session");
      files.importMemory(target, clean.path, api);
      const poisoned = files.exportMemory(mode, "same-session", (db) => {
        db.prepare("UPDATE sessions SET harness = ?").run(INJECTION);
        db.exec("UPDATE messages SET uuid = 'flagged-new', quarantined = 1");
      });
      assert.throws(() => files.importMemory(target, poisoned.path, api), /refusing to merge/);

      const taskHome = join(files.root, "home");
      mkdirSync(taskHome);
      const source = import.meta.url.endsWith(".ts");
      const runner = [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url)),
      ];
      for (const [args, format] of [
        [["search", "metadatarecall"], undefined],
        [["search", "metadatarecall", "--fresh", "--brief", "--json"], undefined],
        [["suggest", "--json"], undefined],
        [["hook", "session-start"], undefined],
        [["hook", "session-start"], "claude"],
      ] as const) {
        const result = await exec(process.execPath, [...runner, "memory", ...args], {
          cwd: files.root,
          env: {
            ...process.env,
            HOME: taskHome,
            KIT_HOOK_JSON: format,
            KIT_NO_HINTS: "1",
            KIT_AUDIT_ANCHOR: "0",
            KIT_NON_INTERACTIVE: "1",
            KIT_SERVICES_FILE: join(files.root, "services.json"),
          },
          timeout: 30_000,
        });
        assert.ok(result.stdout.includes("metadatarecall clean handoff same-session"));
        assert.ok(result.stdout.includes("codex"));
        assert.doesNotMatch(result.stdout, /METADATA_IMPORT_MARKER/);
      }

      const server = createMcpServer();
      const client = new Client({ name: "metadata-import-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const output = await client.callTool({
          name: "kit_memory",
          arguments: { query: "metadatarecall", cwd: files.root, limit: 1 },
        });
        assert.notEqual(output.isError, true);
        assert.ok(JSON.stringify(output).includes("metadatarecall clean handoff same-session"));
        assert.ok(JSON.stringify(output).includes("codex"));
        assert.doesNotMatch(JSON.stringify(output), /METADATA_IMPORT_MARKER/);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
}
