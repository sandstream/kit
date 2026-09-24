import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTriagePass, TRIAGE_LOG_FILE, type TriageLogEntry } from "./triage-receipt.js";

it("appends PASS receipts with an exact spec and default fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kit-triage-receipt-"));
  const logPath = join(cwd, TRIAGE_LOG_FILE);
  const existing = '{"existing":true}\n';
  try {
    await writeFile(logPath, existing);
    const start = Date.now();
    await appendTriagePass({
      type: "npm",
      target: "@acme/plugin",
      triagedSpec: "@acme/plugin@1.2.3",
      sandbox: false,
      cwd,
    });
    await appendTriagePass({
      type: "repo",
      target: "https://example.invalid/project",
      sandbox: true,
      deep: true,
      cwd,
    });
    const end = Date.now();

    const raw = await readFile(logPath, "utf8");
    assert.ok(raw.startsWith(existing), "existing receipt must remain unchanged");
    assert.ok(raw.endsWith("\n"), "each receipt must be a complete JSONL line");
    const lines = raw.trimEnd().split("\n");
    assert.equal(lines.length, 3);

    const first = JSON.parse(lines[1]!) as TriageLogEntry;
    assert.equal(first.type, "npm");
    assert.equal(first.target, "@acme/plugin");
    assert.equal(first.triagedSpec, "@acme/plugin@1.2.3");
    assert.equal(first.sandbox, false);
    assert.equal(first.deep, false);
    assert.equal(first.granter, process.env.USER ?? "unknown");
    assert.ok(Date.parse(first.timestamp) >= start);
    assert.ok(Date.parse(first.timestamp) <= end);

    const second = JSON.parse(lines[2]!) as TriageLogEntry;
    assert.equal(second.target, "https://example.invalid/project");
    assert.equal(second.deep, true);
    assert.equal(second.sandbox, true);
    assert.equal(Object.hasOwn(second, "triagedSpec"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
