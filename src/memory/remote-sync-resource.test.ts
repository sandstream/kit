import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const SNAPSHOTS = 12_000;

function fastImportHistory(repo: string): void {
  const records: string[] = [];
  for (let index = 0; index < SNAPSHOTS; index++) {
    const content = `snapshot-${index}`;
    records.push(
      "commit refs/heads/main",
      `mark :${index + 1}`,
      `committer Fixture <fixture@localhost> ${index + 1} +0000`,
      `data ${String(index).length + 1}`,
      `c${index}`,
      ...(index ? [`from :${index}`] : []),
      "M 100644 inline memory.enc",
      `data ${Buffer.byteLength(content)}`,
      content,
      "",
    );
  }
  const imported = spawnSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: records.join("\n"),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(imported.status, 0, imported.stderr);
}

it("starts replaying a large Git history without one Git process per snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "kit-memory-history-resource-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    fastImportHistory(repo);
    const source = import.meta.url.endsWith(".ts");
    const moduleUrl = new URL(
      source ? "./remote-sync-git.ts" : "./remote-sync-git.js",
      import.meta.url,
    ).href;
    const program = `
      import fs from "node:fs";
      const { gitMemorySnapshots } = await import(process.argv[1]);
      const snapshots = gitMemorySnapshots(process.argv[2], "memory.enc");
      if (!snapshots) throw new Error("history unexpectedly absent");
      const iterator = snapshots[Symbol.iterator]();
      const first = iterator.next();
      if (first.done) throw new Error("history unexpectedly empty");
      process.stdout.write(fs.readFileSync(first.value, "utf8"));
      iterator.return?.();
    `;
    const output = execFileSync(
      process.execPath,
      [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        "--input-type=module",
        "-e",
        program,
        moduleUrl,
        repo,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
    );
    assert.equal(output, "snapshot-0");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
