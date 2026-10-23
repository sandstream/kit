import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPinnedVersions } from "./check-security.js";
import { unpinnedRequirements } from "./pinned-requirements.js";

// "pinned versions" used to answer `pass — all dependencies pinned` for a repo with no
// manifest, for an unparseable package.json, and for a requirements.txt of bare names:
// it only treated `>`, `~` and `!` as unpinned. Each case below passed before this file.

async function inRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-pinned-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return await checkPinnedVersions(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("unpinnedRequirements", () => {
  it("flags every form that does not name one exact version", () => {
    const body = [
      "fastapi",
      "uvicorn<1",
      "httpx>=0.27",
      "rich==13.*",
      "gitingest @ https://example.com/gitingest.tar.gz",
    ].join("\n");
    assert.deepStrictEqual(unpinnedRequirements(body), [
      "fastapi",
      "uvicorn",
      "httpx",
      "rich",
      "gitingest",
    ]);
  });

  it("accepts exact pins with extras, markers, comments and hash continuations", () => {
    const body = [
      "# a comment",
      "",
      "fastapi==0.115.0  # pinned",
      "uvicorn[standard]===0.30.6",
      'tomli==2.0.1 ; python_version < "3.11"',
      "httpx==0.27.2 \\",
      "    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "-r other.txt",
    ].join("\n");
    assert.deepStrictEqual(unpinnedRequirements(body), []);
  });
});

describe("checkPinnedVersions", () => {
  it("skips, never passes, when there is no manifest to read", async () => {
    const r = await inRepo({});
    assert.strictEqual(r.status, "skip");
    assert.match(r.detail, /no package\.json or requirements\.txt/);
  });

  it("warns when package.json cannot be parsed", async () => {
    const r = await inRepo({ "package.json": '{"dependencies": {"left-pad": "*"},}' });
    assert.strictEqual(r.status, "warn");
    assert.match(r.detail, /could not be parsed/);
  });

  it("warns on a requirements.txt of bare names", async () => {
    const r = await inRepo({ "requirements.txt": "fastapi\nuvicorn\n" });
    assert.strictEqual(r.status, "warn");
    assert.strictEqual(r.detail, "2 unpinned dependencies");
  });

  it("names the manifests it read when everything is pinned", async () => {
    const r = await inRepo({
      "package.json": JSON.stringify({ dependencies: { a: "1.2.3" } }),
      "requirements.txt": "fastapi==0.115.0\n",
    });
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.detail, "all dependencies pinned (package.json, requirements.txt)");
  });
});
