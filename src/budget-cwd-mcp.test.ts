import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  budgetContents,
  callFix,
  governanceClient,
  governanceFixture,
  seedBudget,
} from "./governance-outcome.test-support.js";

it("MCP fix charges the requested project and stops before repairs when its budget is exhausted", async (t) => {
  const { host, target } = governanceFixture(t);
  const client = await governanceClient(t);
  assert.equal((await callFix(client, "../target")).ok, true);
  assert.equal(budgetContents(host), undefined);
  assert.equal(JSON.parse(budgetContents(target)!).operations_this_hour, 1);
  assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
  assert.equal(existsSync(join(host, ".kit", "skills-lock.json")), false);
  assert.equal((await callFix(client, target)).ok, true);
  const budgetBefore = budgetContents(target);
  const lockBefore = readFileSync(join(target, ".kit", "skills-lock.json"), "utf8");
  const denied = await client.callTool({ name: "kit_fix", arguments: { cwd: target } });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Operation budget exceeded/);
  assert.equal(budgetContents(target), budgetBefore);
  assert.equal(readFileSync(join(target, ".kit", "skills-lock.json"), "utf8"), lockBefore);
});

it("MCP fix ignores an exhausted host budget and preserves its bytes", async (t) => {
  const { host, target } = governanceFixture(t);
  const hostBefore = seedBudget(host, 100, 2);
  const client = await governanceClient(t);
  assert.equal((await callFix(client, target)).ok, true);
  assert.equal(budgetContents(host), hostBefore);
  assert.equal(JSON.parse(budgetContents(target)!).operations_this_hour, 1);
});
