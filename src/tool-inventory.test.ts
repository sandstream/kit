/**
 * The inventory that did not exist, and the two mappings it needs to get right.
 *
 * `probeName` exists because a declared tool is not the same string as its executable:
 * `[tools]` carries backend prefixes (`aqua:aquasecurity/trivy`, `npm:@socketsecurity/cli`), and
 * probing the raw declaration reported installed tools as "not installed" — the same false
 * statement #500 is about, pointed the other way. Measured before the fix: `kit tools list` said
 * `✗ aqua:aquasecurity/trivy not installed` while trivy 0.72.0 was on PATH via mise.
 *
 * `toLockSource` exists because `cli-lock.json`'s vocabulary is four values wide and the machine
 * has more installers than that. Rather than keep guessing `mise` (the defect), an installer
 * without a lock word maps to `manual` and the measured name is kept alongside in `sourceDetail`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { probeName, toLockSource, AGENT_RELEVANT_TOOLS } from "./tool-inventory.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

describe("probeName", () => {
  it("strips the backend prefix and takes the executable name", () => {
    assert.equal(probeName("aqua:aquasecurity/trivy"), "trivy");
    assert.equal(probeName("aqua:trufflesecurity/trufflehog"), "trufflehog");
    assert.equal(probeName("npm:@socketsecurity/cli"), "cli");
    assert.equal(probeName("pipx:lizard"), "lizard");
    assert.equal(probeName("go:github.com/x/y/cmd/tool"), "tool");
  });

  it("leaves a plain name alone", () => {
    for (const name of ["bun", "vercel", "semgrep", "python3"]) {
      assert.equal(probeName(name), name);
    }
  });

  it("drops a leading @ so a bare scope does not become the probe", () => {
    assert.equal(probeName("npm:@scope"), "scope");
  });
});

describe("toLockSource", () => {
  it("maps the installers the lock can name", () => {
    assert.equal(toLockSource("mise"), "mise");
    assert.equal(toLockSource("asdf"), "mise");
    assert.equal(toLockSource("npm-global"), "npm");
    assert.equal(toLockSource("pipx"), "pip");
  });

  it("maps everything else to manual instead of guessing mise", () => {
    // The defect: brew binaries were recorded as `mise`, and the check agreed (#500).
    for (const source of ["brew", "system", "cargo", "go", "kit-shim", "unknown"] as const) {
      assert.equal(toLockSource(source), "manual", source);
    }
    assert.equal(toLockSource(undefined), "manual");
  });
});

describe("the agent-relevant list", () => {
  it("covers the tools the report named as invisible", () => {
    for (const t of ["gh", "op", "jq", "mise", "docker", "gcloud", "kubectl", "psql"]) {
      assert.ok(
        (AGENT_RELEVANT_TOOLS as readonly string[]).includes(t),
        `${t} was named in #500 as a tool agents decide from`,
      );
    }
  });

  it("has no duplicates — the inventory is a set, not a list that grew", () => {
    const seen = new Set(AGENT_RELEVANT_TOOLS);
    assert.equal(seen.size, AGENT_RELEVANT_TOOLS.length);
  });
});

/**
 * End-to-end, against this machine. Deliberately does NOT assert versions — the point is the
 * shape of the answer: every installed tool gets a measured path and source, and nothing claims
 * `mise` for a binary outside mise. `--latest` is not passed, so no registry is queried.
 */
describe("kit tools list --json (compiled CLI)", () => {
  const run = (): {
    checkedCurrency: boolean;
    tools: Array<{
      name: string;
      declared: string | null;
      path: string | null;
      source: string | null;
      installed: string | null;
      currency: unknown;
    }>;
  } => {
    const r = spawnSync(process.execPath, [CLI_PATH, "tools", "list", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as never;
  };

  it("reports a path and a source for every tool it lists", () => {
    const out = run();
    assert.ok(out.tools.length > 0, "this machine has tools on PATH");
    for (const t of out.tools) {
      if (t.path === null) {
        // Only a DECLARED tool may appear without a path — that absence is the finding.
        assert.notEqual(
          t.declared,
          null,
          `${t.name} is undeclared and missing; it should be omitted`,
        );
        continue;
      }
      assert.ok(t.source, `${t.name} has a path but no measured source`);
    }
  });

  it("does not claim mise for a binary outside mise", () => {
    for (const t of run().tools) {
      if (t.source !== "mise" || !t.path) continue;
      assert.match(
        t.path,
        /mise/,
        `${t.name} is reported as mise-installed but its path is ${t.path}`,
      );
    }
  });

  it("leaves currency unchecked unless --latest is passed", () => {
    const out = run();
    assert.equal(out.checkedCurrency, false);
    for (const t of out.tools) assert.equal(t.currency, null, `${t.name} was checked unasked`);
  });
});
