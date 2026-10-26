import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts", "lockfile-changed-packages.sh");

/** Runs the parser over a lockfile diff, the way triage-deps.yml does. */
function changed(diff: string): string[] {
  const out = execFileSync("bash", [script], { input: diff, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

const resolved = (sign: string, path: string) =>
  `${sign}      "resolved": "https://registry.npmjs.org/${path}",`;

// grep -P and bash are what the Linux CI job runs; the Windows shards have neither reliably.
const posixOnly = { skip: process.platform === "win32" };

describe("lockfile-changed-packages.sh: what triage-deps triages", () => {
  it(
    "reports each added package at its exact version, scoped packages with their scope",
    posixOnly,
    () => {
      const diff = [
        "--- a/package-lock.json",
        "+++ b/package-lock.json",
        resolved("-", "zod/-/zod-4.3.6.tgz"),
        resolved("+", "zod/-/zod-4.6.7.tgz"),
        resolved("+", "@modelcontextprotocol/sdk/-/sdk-1.33.0.tgz"),
        resolved("+", "zod/-/zod-4.6.7.tgz"),
        resolved(" ", "context-only/-/context-only-1.0.0.tgz"),
      ].join("\n");
      assert.deepEqual(changed(diff), ["@modelcontextprotocol/sdk@1.33.0", "zod@4.6.7"]);
    },
  );

  it(
    "keeps pre-release versions and prints nothing for a diff without additions",
    posixOnly,
    () => {
      assert.deepEqual(changed(resolved("+", "@scope/pkg/-/pkg-2.0.0-rc.1.tgz")), [
        "@scope/pkg@2.0.0-rc.1",
      ]);
      assert.deepEqual(changed(resolved("-", "gone/-/gone-1.0.0.tgz")), []);
      assert.deepEqual(changed(""), []);
    },
  );
});

describe("triage-deps.yml: nothing reaches main around the gate", () => {
  const workflow = readFileSync(resolve(root, ".github", "workflows", "triage-deps.yml"), "utf8");

  it("uses the parser, so scoped packages and exact versions are triaged", () => {
    assert.match(workflow, /bash scripts\/lockfile-changed-packages\.sh/);
    // The name check must accept what the parser emits, or every package is skipped.
    assert.match(workflow, /\(@\[0-9A-Za-z\.\+-\]\+\)\?\$/);
  });

  it("never cuts the list short: past the cap the job fails instead", () => {
    assert.doesNotMatch(workflow, /head -\d+/);
    assert.match(workflow, /COUNT" -gt \d+ \]; then[\s\S]*?exit 1/);
  });
});
