import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkGhaWorkflows } from "./check-gha-audit.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(workflows: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-check-gha-"));
  dirs.push(root);
  if (Object.keys(workflows).length > 0) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(workflows)) {
      writeFileSync(join(root, ".github", "workflows", name), text);
    }
  }
  return root;
}

describe("checkGhaWorkflows", () => {
  it("returns the workflow findings gha-audit returns", async () => {
    const root = repo({
      "ci.yml": "on: push\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n",
    });
    const rows = await checkGhaWorkflows(root);
    const row = rows.find((r) => r.name === "unpinned action actions/checkout@v4 (ci.yml)");
    assert.equal(row?.status, "warn");
    assert.equal(row?.rule?.id, "CWE-1357");
  });

  it("passes a repository whose workflows are clean", async () => {
    const root = repo({
      "ci.yml": `on: push\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n`,
    });
    const rows = await checkGhaWorkflows(root);
    assert.deepEqual(
      rows.map((r) => [r.name, r.status]),
      [["gha-audit", "pass"]],
    );
  });

  it("is an honest skip, not a did-not-run, without .github/workflows", async () => {
    const rows = await checkGhaWorkflows(repo({}));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "skip");
    assert.notEqual(rows[0].didNotRun, true);
  });

  it("is wired into kit check's security category", () => {
    // checkSecurity runs every scanner; the wiring is asserted on the source line instead.
    const src = readFileSync(join(import.meta.dirname, "..", "src", "check-security.ts"), "utf8");
    assert.match(src, /import\("\.\/check-gha-audit\.js"\)\)\.checkGhaWorkflows\(root\)/);
  });
});
