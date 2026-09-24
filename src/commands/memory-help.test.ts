import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";

it("memory help describes causal import and recovery without claiming lossless transport", async (t) => {
  const { memory, dbPath } = await fixture(t);
  const help = await memory();
  assert.doesNotMatch(help, /last-write-wins|lossless convergence/i);
  assert.match(help, /pull[^\n]*import[^\n]*snapshot/i);
  assert.match(
    help,
    /task descendants advance[^\n]*alternatives[^\n]*retained[^\n]*explicit resolution/i,
  );
  assert.match(help, /pal \[[^\n]*show[^\n]*resolve[^\n]*forget/);
  assert.match(help, /claim\|renew\|takeover/);
  assert.match(help, /--harness <name> --session <id> --expect <frontier>/);
  assert.match(help, /claimed work.*owner.*receipt/i);
  assert.doesNotMatch(help, /claim = atomic local take/);
  assert.equal(existsSync(dbPath), false, "help does not initialize the private store");
});
