import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CodeQL workflow action", () => {
  it("uses one supported v4 action commit for every CodeQL step", () => {
    const workflows = ["scorecard.yml", "docker-build.yml", "security.yml"];
    const references = workflows.flatMap((name) => {
      const text = readFileSync(resolve(root, ".github/workflows", name), "utf8");
      return [
        ...text.matchAll(/uses:\s*github\/codeql-action\/[^@\s]+@([^\s]+)\s*#\s*([^\n]+)/g),
      ].map((match) => ({ name, sha: match[1], version: match[2].trim() }));
    });

    assert.ok(references.length > 0, "expected at least one CodeQL action step");
    // One full-SHA commit for every step, labelled with a v4 release. The exact patch is left to
    // Dependabot: pinning it here made every patch bump fail this test (#619).
    const shas = new Set(references.map((r) => r.sha));
    assert.equal(shas.size, 1, `CodeQL steps use different commits: ${[...shas].join(", ")}`);
    for (const reference of references) {
      assert.match(reference.sha, /^[0-9a-f]{40}$/, `${reference.name} must pin a full commit SHA`);
      assert.match(reference.version, /^v4\.\d+\.\d+$/, `${reference.name} must identify v4`);
    }
  });
});
