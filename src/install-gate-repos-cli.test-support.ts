import { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const triage = new URL("./triage.js", import.meta.url).href;

/** Isolate CLI state and replace only external triage. Submitted commands remain input data. */
export function repositoryGateFixture() {
  let cwd: string;

  let preload: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "kit-git-source-identity-cli-"));
    preload = join(cwd, "triage-fixture.mjs");
    // Replace the external triage boundary. The compiled CLI and gate remain real.
    // A regression can call only this fixture, never a package registry or repository host.
    writeFileSync(
      preload,
      `import { mock } from "node:test";
const original = await import(${JSON.stringify(triage)});
mock.module(${JSON.stringify(triage)}, {
  namedExports: {
    ...original,
    runTriage: async (type, target) => {
      process.stderr.write("FIXTURE_TRIAGE " + type + ":" + target + "\\n");
      return { type, target, passed: true, output: "TRIAGE PASSED" };
    },
  },
});
`,
    );
  });

  after(() => rmSync(cwd, { recursive: true, force: true }));

  function gate(command: string, format?: "cline") {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--import",
        preload,
        cli,
        "gate-bash",
        ...(format ? ["--format", format] : []),
      ],
      {
        cwd,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_NO_UPDATE_CHECK: "1",
          KIT_NON_INTERACTIVE: "1",
        },
      },
    );
    assert.ifError(result.error);
    return result;
  }
  return gate;
}
