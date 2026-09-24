import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEQL_ACTION_SHA = "1c5b675653bb5c22dbe9b12b556ec555138e09fd";

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
    for (const reference of references) {
      assert.equal(reference.sha, CODEQL_ACTION_SHA, `${reference.name} has a stale CodeQL pin`);
      assert.equal(reference.version, "v4.38.1", `${reference.name} must identify supported major`);
    }
  });
});
