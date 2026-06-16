import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { openMemoryDb, insertMessage } from "./db.js";
import { palAdd } from "./pal.js";
import { getCurrentProjectRoot } from "./project.js";
import { buildSuggestPrompt } from "./suggest.js";

describe("memory suggest — BYO-LLM prompt builder", () => {
  let tmp: string;
  const prev = process.env.KIT_MEMORY_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-suggest-"));
    process.env.KIT_MEMORY_DB = join(tmp, "memory.db");
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_MEMORY_DB;
    else process.env.KIT_MEMORY_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("builds a prompt from recent project messages + open items, never calls a model", () => {
    const root = getCurrentProjectRoot();
    const db = openMemoryDb();
    insertMessage(db, {
      uuid: "s1",
      sessionId: "x",
      type: "user",
      role: "user",
      content: "wire up the october invoice export",
      cwd: root,
      timestamp: "2026-05-01T10:00:00Z",
    });
    insertMessage(db, {
      uuid: "s2",
      sessionId: "x",
      type: "assistant",
      role: "assistant",
      content: "done, exporter shipped",
      cwd: root,
      timestamp: "2026-05-01T10:01:00Z",
    });
    palAdd(db, { title: "rotate the leaked stripe key", scope: basename(root) });

    const out = buildSuggestPrompt(db);
    db.close();

    assert.equal(out.project, basename(root));
    assert.equal(out.recentCount, 2);
    assert.equal(out.openItems, 1);
    // recent content is included
    assert.match(out.prompt, /october invoice export/);
    // open items are surfaced as "do not duplicate"
    assert.match(out.prompt, /rotate the leaked stripe key/);
    assert.match(out.prompt, /do not duplicate/i);
    // the instruction + record commands are present
    assert.match(out.prompt, /TASK:/);
    assert.match(out.prompt, /kit memory pal add/);
    assert.match(out.prompt, /kit memory share/);
  });

  it("handles an empty project gracefully (no messages indexed)", () => {
    const db = openMemoryDb(":memory:");
    const out = buildSuggestPrompt(db);
    db.close();
    assert.equal(out.recentCount, 0);
    assert.match(out.prompt, /none indexed/);
    assert.match(out.prompt, /TASK:/);
  });
});
