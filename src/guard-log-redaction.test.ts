import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { appendObservation, readObservations } from "./guard.js";
import { governanceFixture } from "./governance-outcome.test-support.js";

function row(secret: string) {
  const url = `https://fixture:${secret}@github.com/example/repo.git`;
  return {
    ts: "2026-11-05T00:00:00Z",
    cwd: "/fixture",
    tool: "git",
    command: `git clone ${url}`,
    reason: `clone ${url}`,
    refs: [`repo:${url}`],
    wouldBlock: false,
  };
}

it("redacts observation fields before truncation", (t) => {
  const { root } = governanceFixture(t);
  const path = join(root, "guard.jsonl");
  process.env.KIT_GUARD_LOG = path;
  const secret = "X".repeat(210);
  appendObservation(row(secret));
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("X".repeat(10)), "no credential fragment may survive truncation");
  assert.match(text, /REDACTED/);
  assert.equal(readObservations().length, 1);
});

it("redacts historical observations on read without rewriting the log", (t) => {
  const { root } = governanceFixture(t);
  const path = join(root, "guard.jsonl");
  process.env.KIT_GUARD_LOG = path;
  const secret = "fixture-private-password";
  const original = JSON.stringify(row(secret)) + "\n";
  writeFileSync(path, original);
  const rows = readObservations();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.match(JSON.stringify(rows), /REDACTED/);
  assert.equal(readFileSync(path, "utf8"), original);
});

it("masks long percent-encoded userinfo before writing or reading a guard log", (t) => {
  const { root } = governanceFixture(t);
  const path = join(root, "guard.jsonl");
  process.env.KIT_GUARD_LOG = path;
  const secret = "%41".repeat(100);
  appendObservation(row(secret));
  assert.ok(!readFileSync(path, "utf8").includes("%41"));
  writeFileSync(path, JSON.stringify(row(secret)) + "\n");
  assert.ok(!JSON.stringify(readObservations()).includes("%41"));
});
