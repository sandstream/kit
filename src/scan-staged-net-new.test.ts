import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStagedFiles } from "./scan-staged.js";

function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-staged-new-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  return dir;
}

describe("only findings new to this commit block it", () => {
  // A finding already committed in HEAD is not news to the hook: blocking every later
  // commit that touches the file (a CHANGELOG, a doc with an example value) leaves
  // `--no-verify` as the only way out, and that disables the whole hook.
  const docExample = 'VITE_DEMO_SECRET_KEY = "demo tenant, rotated nightly"\n';
  const stripe = "STRIPE_SECRET_KEY=sk_te" + "st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n";

  function committed(dir: string, file: string, content: string): void {
    writeFileSync(join(dir, file), content);
    execSync(`git add ${file} && git commit -qm base`, { cwd: dir });
  }

  it("passes an edit to a file whose existing finding is already in HEAD", async () => {
    const dir = tmpGitRepo();
    try {
      committed(dir, "CHANGELOG.md", "# Changes\n\n" + docExample);
      writeFileSync(join(dir, "CHANGELOG.md"), "# Changes\n\n- new entry\n\n" + docExample);
      execSync("git add CHANGELOG.md", { cwd: dir });
      assert.deepEqual(await scanStagedFiles(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still blocks a new secret added next to an existing finding", async () => {
    const dir = tmpGitRepo();
    try {
      committed(dir, "CHANGELOG.md", docExample);
      writeFileSync(join(dir, "CHANGELOG.md"), docExample + stripe);
      execSync("git add CHANGELOG.md", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
      // Every remaining finding belongs to the new Stripe line, none to the committed example.
      assert.ok(hits[0].findings.every((f) => !f.preview.startsWith("VITE_D")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a second copy of a secret HEAD already holds", async () => {
    const dir = tmpGitRepo();
    try {
      committed(dir, "app.env", stripe);
      writeFileSync(join(dir, "app.env"), stripe + stripe);
      execSync("git add app.env", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a secret in a newly added file", async () => {
    const dir = tmpGitRepo();
    try {
      committed(dir, "README.md", "# x\n");
      writeFileSync(join(dir, "new.md"), docExample);
      execSync("git add new.md", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, "new.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
