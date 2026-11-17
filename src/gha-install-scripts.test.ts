import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditInstallScripts, runCommands, scriptedInstalls } from "./gha-install-scripts.js";
import { auditWorkflow } from "./gha-audit.js";

const wf = (...lines: string[]): string => lines.join("\n") + "\n";
const names = (content: string): string[] =>
  auditInstallScripts(content, "ci.yml").map((f) => f.name);

describe("auditInstallScripts: flags secrets", () => {
  it("npm ci in a job with a secret in env (the wfx-loot shape), with the file line", () => {
    const content = wf(
      "on: push",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "    steps:",
      "      - uses: actions/checkout@1234567890123456789012345678901234567890",
      "      - run: npm ci",
    );
    const rows = auditInstallScripts(content, "ci.yml");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "install scripts run with credentials: job release (ci.yml:9)");
    assert.equal(rows[0].severity, "high");
    assert.equal(rows[0].status, "warn");
    assert.equal(rows[0].rule?.id, "CWE-829");
    assert.match(rows[0].detail, /secrets NPM_TOKEN/);
    assert.match(rows[0].suggestion ?? "", /--ignore-scripts/);
    assert.match(rows[0].suggestion ?? "", /job that holds no secrets/);
  });

  it("npm install and npm i, in a block run, when a secret is passed in `with:`", () => {
    const content = wf(
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - uses: some/action@1234567890123456789012345678901234567890",
      "        with:",
      "          token: ${{ secrets.GITHUB_TOKEN }}",
      "      - name: deps",
      "        run: |",
      "          npm install",
      "          npm i left-pad",
    );
    assert.deepEqual(names(content), [
      "install scripts run with credentials: job deploy (ci.yml:9)",
      "install scripts run with credentials: job deploy (ci.yml:10)",
    ]);
    assert.match(auditInstallScripts(content, "ci.yml")[0].detail, /secrets GITHUB_TOKEN/);
  });

  it("a secret referenced only in a run line counts", () => {
    const content = wf(
      "jobs:",
      "  x:",
      "    steps:",
      "      - run: npm ci && curl -H 'a: ${{ secrets.API }}' https://example.invalid",
    );
    assert.equal(names(content).length, 1);
  });

  it("finds the right line for a job id that holds a dash, after a job whose id it extends", () => {
    const content = wf(
      "jobs:",
      "  dogfood:",
      "    steps:",
      "      - run: echo hi",
      "  dogfood-scan:",
      "    env:",
      "      T: ${{ secrets.T }}",
      "    steps:",
      "      - run: npm ci",
    );
    assert.deepEqual(names(content), [
      "install scripts run with credentials: job dogfood-scan (ci.yml:9)",
    ]);
  });
});

describe("auditInstallScripts: flags OIDC grants", () => {
  it("job-level id-token: write", () => {
    const content = wf(
      "jobs:",
      "  publish:",
      "    permissions:",
      "      contents: read",
      "      id-token: write",
      "    steps:",
      "      - run: npm ci",
    );
    const rows = auditInstallScripts(content, "ci.yml");
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /holds id-token: write and runs `npm ci`/);
  });

  it("workflow-level id-token: write is inherited by a job without its own permissions", () => {
    const content = wf(
      "on: push",
      "permissions:",
      "  id-token: write",
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: npm ci",
      "  scoped:",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - run: npm ci",
    );
    const rows = auditInstallScripts(content, "ci.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["install scripts run with credentials: job build (ci.yml:7)"],
      "a job with its own permissions block does not inherit the workflow's",
    );
    assert.match(rows[0].detail, /inherited from the workflow/);
  });

  it("workflow-level write-all and a workflow-level env secret both count", () => {
    const writeAll = wf(
      "permissions: write-all",
      "jobs:",
      "  b:",
      "    steps:",
      "      - run: npm ci",
    );
    assert.equal(names(writeAll).length, 1);
    const env = wf(
      "env:",
      "  TOKEN: ${{ secrets.TOKEN }}",
      "jobs:",
      "  b:",
      "    steps:",
      "      - run: npm ci",
    );
    assert.match(auditInstallScripts(env, "ci.yml")[0].detail, /secrets TOKEN/);
  });

  it("reaches gha-audit's auditWorkflow", () => {
    const content = wf(
      "jobs:",
      "  x:",
      "    env:",
      "      T: ${{ secrets.T }}",
      "    steps:",
      "      - run: npm ci",
    );
    assert.ok(auditWorkflow(content, "ci.yml").some((f) => f.name.startsWith("install scripts")));
  });
});

describe("auditInstallScripts: does not flag", () => {
  it("--ignore-scripts on the same command, or on a continuation line", () => {
    const content = wf(
      "jobs:",
      "  x:",
      "    env:",
      "      T: ${{ secrets.T }}",
      "    steps:",
      "      - run: npm ci --ignore-scripts",
      "      - run: |",
      "          npm install \\",
      "            --ignore-scripts",
    );
    assert.deepEqual(names(content), []);
  });

  it("a job that holds no credential", () => {
    const content = wf(
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm ci",
    );
    assert.deepEqual(names(content), []);
  });

  it("an install that only appears in a comment, a step name, or a commented-out secret", () => {
    const content = wf(
      "jobs:",
      "  x:",
      "    env:",
      "      T: ${{ secrets.T }}",
      "    steps:",
      "      # - run: npm ci",
      "      - name: npm ci (skipped)",
      "        run: echo done # npm ci later",
      "  y:",
      "    steps:",
      "      # token: ${{ secrets.T }}",
      "      - run: npm ci",
    );
    assert.deepEqual(names(content), []);
  });

  it("npm commands that are not installs", () => {
    const body = ["    steps:", "      - run: npm init -y && npm test && npm run ci"];
    assert.deepEqual(scriptedInstalls(body), []);
  });

  it("--ignore-scripts=false is not an opt-out", () => {
    const body = ["    steps:", "      - run: npm ci --ignore-scripts=false"];
    assert.equal(scriptedInstalls(body).length, 1);
  });
});

describe("runCommands", () => {
  it("reads inline and block run values, with their offsets", () => {
    const body = [
      "    steps:",
      "      - run: echo one",
      "      - name: two",
      "        run: >-",
      "          echo two",
      "      - uses: x/y@1234567890123456789012345678901234567890",
    ];
    assert.deepEqual(runCommands(body), [
      [1, "echo one"],
      [4, "echo two"],
    ]);
  });
});
