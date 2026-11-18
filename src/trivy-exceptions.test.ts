import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = ".trivyignore.yaml";
const text = readFileSync(join(root, FILE), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "docker-build.yml"), "utf8");

// The image scan fails the Docker job, and with it every merge, on any HIGH or CRITICAL finding.
// npm's own bundled picomatch has one with no patched version. A waiver is allowed only when it
// is narrow: one id, one path, a statement, and an end date. Trivy stops honouring it on that date.

interface Entry {
  id: string;
  paths: string[];
  statement: string;
  expiredAt: string;
}

/** Read the small, fixed shape of the ignore file. No YAML dependency: kit has four. */
function entries(): Entry[] {
  const blocks = text.split(/^ {2}- id: /m).slice(1);
  return blocks.map((block) => {
    const id = block.split("\n")[0].trim();
    const paths = [...block.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
    const statement = /^ {4}statement: (.+)$/m.exec(block)?.[1] ?? "";
    const expiredAt = /^ {4}expired_at: (\d{4}-\d{2}-\d{2})$/m.exec(block)?.[1] ?? "";
    return { id, paths, statement, expiredAt };
  });
}

describe("Trivy exceptions", () => {
  it("the image scan reads the ignore file", () => {
    const scan = workflow.slice(workflow.indexOf("- name: Image vulnerability scan"));
    assert.match(scan.split("\n      - name:")[0], /trivyignores:\s*\.trivyignore\.yaml/);
  });

  it("every entry names one CVE, the exact path, a statement and an end date", () => {
    const list = entries();
    assert.ok(list.length >= 1, "the ignore file lists the picomatch finding");
    for (const e of list) {
      assert.match(e.id, /^CVE-\d{4}-\d{4,}$/, `${e.id}: a CVE id, never a wildcard`);
      assert.ok(e.paths.length >= 1, `${e.id}: scoped to a path, so another copy still fails`);
      for (const p of e.paths) assert.doesNotMatch(p, /[*?]/, `${e.id}: no wildcard in ${p}`);
      assert.ok(e.statement.length >= 20, `${e.id}: say why`);
      assert.ok(!Number.isNaN(Date.parse(e.expiredAt)), `${e.id}: expired_at is a date`);
    }
  });

  it("covers only npm's bundled picomatch, nothing else", () => {
    const list = entries();
    assert.deepEqual(
      list.flatMap((e) => e.paths),
      [
        "usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch/package.json",
      ],
    );
  });
});
