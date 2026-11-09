import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, meta, call, result } from "./tool-capture.test-support.js";

it("an unmatched response file is retried after another file supplies its request", (t) => {
  const f = fixture(t, "codex", [meta, result()]);
  f.index();
  writeFileSync(
    join(f.file, "..", "rollout-later.jsonl"),
    [meta, call()].map((r) => JSON.stringify(r)).join("\n"),
  );
  f.index();
  f.index();
  assert.equal(f.db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "returned");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 1);
});
