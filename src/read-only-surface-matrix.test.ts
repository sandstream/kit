import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { COMMANDS } from "./cli.js";
import { WRITE_SURFACE, matchWriteSurface } from "./read-only-surface.js";
import {
  MUTATING_COMMANDS,
  PURE_READ_COMMANDS,
  READ_INVOCATIONS,
  SHARD_COUNT,
  commandShard,
} from "./read-only-surface-matrix-fixture.js";

describe("read-only classifier matrix", () => {
  it("classifies every mutating CLI form", () => {
    const actual = MUTATING_COMMANDS.map(({ label, args }) => ({
      label,
      operation: matchWriteSurface(["node", "kit", ...args])?.operation ?? null,
    }));
    const expected = MUTATING_COMMANDS.map(({ label, operation }) => ({ label, operation }));

    assert.deepEqual(actual, expected);
  });

  it("preserves every reviewed read form", () => {
    for (const command of PURE_READ_COMMANDS) {
      assert.equal(matchWriteSurface(["node", "kit", command]), null, command);
    }
    for (const args of READ_INVOCATIONS) {
      assert.equal(matchWriteSurface(["node", "kit", ...args]), null, args.join(" "));
    }
  });

  it("accounts for every registered top-level command", () => {
    const mutationCapable = new Set(MUTATING_COMMANDS.map(({ args }) => args[0]));
    const overlap = PURE_READ_COMMANDS.filter((command) => mutationCapable.has(command));
    assert.deepEqual(overlap, [], "commands classified as both read and mutation-capable");

    const reviewed = new Set([...PURE_READ_COMMANDS, ...mutationCapable]);
    assert.deepEqual([...reviewed].sort(), Object.keys(COMMANDS).sort());
  });

  it("assigns every mutation to exactly one dispatch shard", () => {
    const assigned = Array.from({ length: SHARD_COUNT }, (_, index) => commandShard(index)).flat();
    assert.equal(assigned.length, MUTATING_COMMANDS.length);
    assert.deepEqual(new Set(assigned), new Set(MUTATING_COMMANDS));
  });

  it("has a test file for each dispatch shard", () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    for (let index = 1; index <= SHARD_COUNT; index++) {
      const name = `read-only-surface-matrix-${String(index).padStart(2, "0")}.test.${extension}`;
      assert.equal(existsSync(new URL(name, import.meta.url)), true, name);
    }
  });

  it("keeps write-surface operation names unambiguous", () => {
    const operations = WRITE_SURFACE.map(({ operation }) => operation);
    assert.equal(new Set(operations).size, operations.length);
  });
});
