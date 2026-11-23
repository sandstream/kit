import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rmTemp } from "../temp-cleanup.test-support.js";

test("kit security scan-transcripts requires complete evidence for a clean result", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-transcript-command-"));
  t.after(() => rmTemp(root));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  const args = [
    fileURLToPath(new URL("../cli.js", import.meta.url)),
    "security",
    "scan-transcripts",
  ];
  const run = () =>
    spawnSync(process.execPath, args, {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        KIT_READ_ONLY: "1",
        KIT_NO_UPDATE_CHECK: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });

  const missing = run();
  assert.ifError(missing.error);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No supported agent transcript directories/);

  const agent = join(repo, ".claude");
  const session = join(agent, "session.jsonl");
  mkdirSync(agent);
  writeFileSync(session, "{}\n");
  const clean = run();
  assert.ifError(clean.error);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /No credentials found.*Scanned 1 file in 1 directory/);

  const large = join(agent, "large.jsonl");
  writeFileSync(large, "");
  truncateSync(large, 10 * 1024 * 1024 + 1);
  const partial = run();
  assert.ifError(partial.error);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /Coverage unverified.*oversized/);
  assert.doesNotMatch(partial.stdout, /No credentials found/);

  const credential = ["AKIA", "0123456789ABCDEF"].join("");
  writeFileSync(session, JSON.stringify({ text: credential }));
  const finding = run();
  assert.ifError(finding.error);
  assert.equal(finding.status, 1);
  assert.match(finding.stderr, /Coverage unverified.*oversized/);
  assert.match(finding.stderr, /session\.jsonl.*aws-access-key/);
  assert.ok(!finding.stderr.includes(credential));
});
