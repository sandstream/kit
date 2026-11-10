import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import {
  governanceClient,
  governanceFixture,
  projectConfig,
} from "./governance-outcome.test-support.js";

for (const broker of [false, true]) {
  it(`MCP run retains failed output and audits the child outcome (broker=${broker})`, async (t) => {
    const { host, target } = governanceFixture(t);
    if (broker)
      writeFileSync(
        join(target, ".kit-exec-broker.json"),
        JSON.stringify({ egress: { allow: [] }, fs: { root: target }, env: { declared: [] } }),
      );
    const client = await governanceClient(t);
    for (const code of [7, 0]) {
      const script = join(target, `exit-${code}.cjs`);
      writeFileSync(script, `console.log('child-${code}'); process.exit(${code});`);
      const result = await client.callTool({
        name: "kit_run",
        arguments: { cwd: target, command: `"${process.execPath}" "${script}"` },
      });
      assert.equal(Boolean(result.isError), code !== 0, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), new RegExp(`Exit code: ${code}`));
      assert.match(JSON.stringify(result.content), new RegExp(`child-${code}`));
      const events = (await readAuditLog(join(target, ".kit-audit.jsonl"))).filter(
        (event) => event.operation === "run" && event.metadata?.phase !== "authorized",
      );
      const recent = events.slice(-(broker ? 2 : 1));
      assert.equal(recent.length, broker ? 2 : 1);
      assert.ok(
        recent.every((event) => event.success === (code === 0)),
        JSON.stringify(recent),
      );
      if (code !== 0) assert.ok(recent.every((event) => /7/.test(event.error ?? "")));
    }
    assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
  });
}

for (const configState of ["invalid", "directory", "absent", "denied"] as const) {
  it(`MCP run handles ${configState} config without disabling declared policy`, async (t) => {
    const { target } = governanceFixture(t);
    const path = join(target, ".kit.toml");
    rmSync(path);
    if (configState === "directory") mkdirSync(path);
    if (configState === "invalid") writeFileSync(path, "[broken TOML");
    if (configState === "denied")
      writeFileSync(
        path,
        `${projectConfig}\n[governance.access.dev]\nread = true\nwrite = false\ndelete = false\n`,
      );
    const marker = join(target, "child-ran");
    const script = join(target, "marker.cjs");
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
    );
    const client = await governanceClient(t);
    const result = await client.callTool({
      name: "kit_run",
      arguments: { cwd: target, command: `"${process.execPath}" "${script}"` },
    });
    assert.equal(existsSync(marker), configState === "absent", JSON.stringify(result));
    assert.equal(Boolean(result.isError), configState !== "absent", JSON.stringify(result));
  });
}
