import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import {
  callFix,
  governanceClient,
  governanceFixture,
  projectConfig,
} from "./governance-outcome.test-support.js";

for (const brokerEnabled of [false, true]) {
  it(`MCP fix audits a template failure honestly and retains repair actions (broker=${brokerEnabled})`, async (t) => {
    const { host, target } = governanceFixture(t);
    writeFileSync(
      join(target, ".kit.toml"),
      `${projectConfig}
[secrets]
template = "missing/parent/.env.template"
[secrets.keys.TEST_KEY]
source = "env"
`,
    );
    if (brokerEnabled) {
      writeFileSync(
        join(target, ".kit-exec-broker.json"),
        JSON.stringify({
          egress: { allow: [] },
          fs: { root: target },
          env: { declared: [] },
        }),
      );
    }
    const client = await governanceClient(t);
    const result = await callFix(client, target);
    assert.equal(result.ok, false);
    const failure = result.actions.find((action) => action.action === "failed");
    assert.equal(failure?.name, "missing/parent/.env.template");
    assert.ok(
      result.actions.some(
        (action) => action.name === "skills-lock.json" && action.action === "generated",
      ),
    );
    assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
    const completed = (await readAuditLog(join(target, ".kit-audit.jsonl"))).filter(
      (event) => event.operation === "fix" && event.metadata?.phase !== "authorized",
    );
    assert.equal(completed.length, brokerEnabled ? 2 : 1);
    for (const event of completed) {
      assert.equal(event.success, false, `${event.environment} must record the action failure`);
      assert.ok(event.error?.includes(failure!.detail));
    }
    mkdirSync(join(target, "missing", "parent"), { recursive: true });
    const repaired = await callFix(client, target);
    assert.equal(repaired.ok, true);
    assert.ok(
      repaired.actions.some(
        (action) => action.name === failure!.name && action.action === "generated",
      ),
    );
    const finalEvents = (await readAuditLog(join(target, ".kit-audit.jsonl")))
      .filter((event) => event.metadata?.phase !== "authorized")
      .slice(completed.length);
    assert.equal(finalEvents.length, brokerEnabled ? 2 : 1);
    assert.ok(finalEvents.every((event) => event.success === true && event.error === undefined));
  });
}
