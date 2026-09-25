import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  linkSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * publish.yml ↔ npm's trusted-publishing prerequisites.
 *
 * npm is retiring 2FA-bypass granular access tokens as a publishing credential:
 * from ~January 2027 such a token can only read private packages and STAGE a
 * publish for human 2FA approval. The migration target is trusted publishing —
 * an OIDC exchange with no long-lived secret at all — and it exists only in
 * **npm >= 11.5.1 on node >= 22.14.0**.
 *
 * `actions/setup-node` with `node-version: "22"` ships npm 10.9.x, so the client
 * in this job has no OIDC exchange to make. That is a prerequisite the repo can
 * assert about itself today, before the registry-side switch (which is
 * per-package configuration on npmjs.com — see docs/RELEASING.md), so the
 * migration cannot arrive to find the runner too old.
 *
 * The gate is here rather than in prose because a comment cannot fail CI, and a
 * publish job only ever runs on a tag push — the worst possible moment to learn
 * that its npm is too old.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8");

/** The workflow with its comment lines removed. Every assertion below is about what the job
 *  RUNS, and this file is heavily commented — a comment that merely mentions `npm publish`
 *  must not be mistaken for the step that performs it. */
const EXECUTED = WORKFLOW.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

function stepBody(name: string): string {
  const start = EXECUTED.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `missing publish step: ${name}`);
  const end = EXECUTED.indexOf("\n      - name:", start + name.length);
  return EXECUTED.slice(start, end < 0 ? undefined : end);
}

function beforePublish(name: string): string {
  const body = stepBody(name);
  assert.ok(
    EXECUTED.indexOf(`- name: ${name}`) <
      EXECUTED.indexOf("- name: Publish to npm with provenance"),
    `${name} must run before publishing`,
  );
  assert.doesNotMatch(body, /continue-on-error:\s*true|if:\s*always\(\)/);
  return body;
}

/** npm's documented floor for trusted publishing. */
const MIN_NPM = [11, 5, 1] as const;

function atLeast(found: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const f = found[i] ?? 0;
    if (f > min[i]) return true;
    if (f < min[i]) return false;
  }
  return true;
}

function commitFixture(root: string, message: string): string {
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  ]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function createPublishFixture(root: string): { first: string; second: string; binDir: string } {
  const pkgDir = join(root, "packages", "kit-plugin-demo");
  const binDir = join(root, "bin");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(binDir);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "kit-fixture", version: "1.0.0" }),
  );
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "kit-plugin-demo", version: "0.1.0" }),
  );
  writeFileSync(join(pkgDir, "index.js"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", root]);
  const first = commitFixture(root, "first");
  const fakeNpm = `#!/usr/bin/env node
const spec = process.argv[3];
const state = JSON.parse(process.env.FAKE_NPM_STATE || '{}');
if (state[spec] === 'offline') { process.stderr.write('network unavailable'); process.exit(1); }
if (!(spec in state)) { process.stderr.write('npm ERR! code E404\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(state[spec]) + '\\n');
`;
  if (process.platform === "win32") {
    const alias = join(binDir, "npm.exe");
    try {
      linkSync(process.execPath, alias);
    } catch {
      copyFileSync(process.execPath, alias);
    }
    writeFileSync(
      join(binDir, "fixture-loader.mjs"),
      [
        'if (process.argv[1] === "view") {',
        "  const spec = process.argv[2];",
        '  const state = JSON.parse(process.env.FAKE_NPM_STATE || "{}");',
        '  if (state[spec] === "offline") { process.stderr.write("network unavailable"); process.exit(1); }',
        '  if (!(spec in state)) { process.stderr.write("npm ERR! code E404\\n"); process.exit(1); }',
        '  process.stdout.write(JSON.stringify(state[spec]) + "\\n");',
        "  process.exit(0);",
        "}",
      ].join("\n"),
    );
  } else {
    writeFileSync(join(binDir, "npm"), fakeNpm);
    chmodSync(join(binDir, "npm"), 0o755);
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "kit-fixture", version: "1.1.0" }),
  );
  writeFileSync(join(pkgDir, "index.js"), "export const value = 2;\n");
  const second = commitFixture(root, "second");
  return { first, second, binDir };
}

function runPublishGuard(root: string, binDir: string, state: Record<string, string>) {
  return spawnSync(process.execPath, [join(REPO_ROOT, "scripts/verify-published-versions.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_NPM_STATE: JSON.stringify(state),
      ...(process.platform === "win32"
        ? {
            NODE_OPTIONS: `--import=${pathToFileURL(join(binDir, "fixture-loader.mjs")).href}`,
          }
        : {}),
    },
  });
}

describe("publish.yml — publishes over OIDC, not a long-lived token", () => {
  it("references no npm token in any executing line", () => {
    // The packages that shipped before sandstream-kit-plugin-aisle have a GitHub Actions
    // trusted publisher (repo sandstream/kit, workflow publish.yml, environment npm-publish,
    // permission `npm publish`), verified on each package's settings page. npm prefers
    // NODE_AUTH_TOKEN whenever it is present, so
    // OIDC only takes effect once that env is gone — the two cannot both be in effect, which
    // makes a re-added token a SILENT downgrade back to the credential npm is retiring
    // (direct publishing dies ~Jan 2027). Hence a gate rather than a comment.
    const offenders = EXECUTED.split("\n").filter((l) => /NPM_TOKEN|NODE_AUTH_TOKEN/.test(l));
    assert.deepEqual(
      offenders,
      [],
      "publish.yml must not carry an npm token: trusted publishing is the credential now",
    );
  });

  it("still asks for the OIDC identity it publishes with", () => {
    assert.match(WORKFLOW, /id-token:\s*write/);
  });
});

describe("publish.yml — the signature gate cannot fail open", () => {
  it("takes the tag verdict from git verify-tag, not from a pipe", () => {
    // Shipped as `if ! git verify-tag "$TAG" 2>&1 | tee /tmp/tag-verify.log; then`. git exits
    // 1 on an unsigned tag; the pipeline reported tee's zero, so the gate never fired and an
    // unsigned v6.6.3 published with every GPG pin around it intact and useless. The default
    // step shell is `bash -e {0}` — pipefail is not on unless the step asks for it.
    const verify = EXECUTED.match(/if !\s*git verify-tag[^\n]*/);
    assert.ok(verify, "publish.yml no longer verifies the tag signature");
    assert.doesNotMatch(
      verify[0],
      /\|\s*(tee|cat)\b/,
      "the verdict must not come from a pass-through sink",
    );
  });

  it("sets pipefail in that step regardless", () => {
    const step = EXECUTED.slice(
      EXECUTED.indexOf("Verify tag is GPG-signed"),
      EXECUTED.indexOf("if !", EXECUTED.indexOf("Verify tag is GPG-signed")),
    );
    assert.match(step, /set -o pipefail|set -euo pipefail/);
  });
});

describe("publish.yml — trusted-publishing prerequisites", () => {
  it("installs an npm that has the OIDC exchange (>= 11.5.1)", () => {
    const m = EXECUTED.match(/npm (?:i|install) -g npm@(\d+)\.(\d+)\.(\d+)/);
    assert.ok(
      m,
      "publish.yml must install npm explicitly: setup-node's bundled npm for node 22 is 10.9.x, which predates trusted publishing (>= 11.5.1)",
    );
    const found = [Number(m[1]), Number(m[2]), Number(m[3])];
    assert.ok(
      atLeast(found, MIN_NPM),
      `publish.yml pins npm ${found.join(".")}, below trusted publishing's floor ${MIN_NPM.join(".")}`,
    );
  });

  it("upgrades npm BEFORE the first publish", () => {
    const upgrade = EXECUTED.search(/npm (?:i|install) -g npm@/);
    const publish = EXECUTED.indexOf("npm publish");
    assert.ok(publish > 0, "publish.yml no longer runs `npm publish`");
    assert.ok(
      upgrade > 0 && upgrade < publish,
      "the npm upgrade must run before any publish step, or the publish uses the old client",
    );
  });

  it("asks for a node that admits that npm (>= 22.14.0)", () => {
    const m = EXECUTED.match(/node-version:\s*"?(\d+)(?:\.(\d+))?(?:\.(\d+))?"?/);
    assert.ok(m, "publish.yml must declare a node-version");
    const major = Number(m[1]);
    // A bare major ("22") resolves to the latest 22.x, which is >= 22.14. A pinned
    // minor must clear 22.14 itself.
    if (m[2] === undefined) {
      assert.ok(major >= 22, `node-version ${major} predates trusted publishing's node floor`);
      return;
    }
    assert.ok(
      atLeast([major, Number(m[2]), Number(m[3] ?? 0)], [22, 14, 0]),
      `node-version ${m[0]} is below node 22.14.0`,
    );
  });
});

describe("publish.yml — documented release gates execute before publication", () => {
  it("binds the tag to the package version", () => {
    const body = beforePublish("Verify tag matches package.json version");
    assert.match(body, /PKG_VERSION=.*package\.json/);
    assert.match(body, /TAG_VERSION="\$\{TAG#v\}"/);
    assert.match(body, /if \[ "\$PKG_VERSION" != "\$TAG_VERSION" \]; then[\s\S]*?exit 1/);
  });

  it("requires matching changelog notes", () => {
    const body = beforePublish("Verify the CHANGELOG documents this version");
    assert.match(body, /if ! node scripts\/changelog-section\.mjs "\$VERSION"/);
    assert.match(body, /exit 1/);
  });

  it("requires one maintainer key with the pinned fingerprint and a signed tag", () => {
    const key = beforePublish("Import maintainer public key");
    assert.match(key, /EXPECTED_FPR: \$\{\{ secrets\.MAINTAINER_KEY_FPR \}\}/);
    assert.match(key, /if \[ -z "\$EXPECTED_FPR" \]; then[\s\S]*?exit 1/);
    assert.match(key, /if \[ "\$NKEYS" != "1" \]; then[\s\S]*?exit 1/);
    assert.match(key, /if \[ "\$NORM_FPR" != "\$NORM_EXP" \]; then[\s\S]*?exit 1/);
    const signature = beforePublish("Verify tag is GPG-signed");
    assert.match(signature, /if ! git verify-tag "\$TAG"[^\n]*; then[\s\S]*?exit 1/);
  });

  it("requires audit and a fail-closed supply-chain scan", () => {
    assert.match(beforePublish("npm audit (high+)"), /run: npm audit --audit-level=high/);
    const supply = beforePublish("Bumblebee supply-chain gate");
    assert.match(supply, /KIT_BUMBLEBEE_REQUIRED:\s*"1"/);
    assert.match(supply, /node scripts\/run-supply-chain-check\.mjs/);
  });

  it("runs tests and production build", () => {
    assert.match(beforePublish("Run tests"), /run: npm test/);
    assert.match(beforePublish("Build production artifacts"), /run: npm run build:prod/);
  });

  it("checks SDK major and each plugin peer range", () => {
    const body = beforePublish("Verify the adapter-SDK contract the plugins are published against");
    assert.match(body, /SDK_VER=.*adapter-sdk\/package\.json/);
    assert.match(body, /1\.\*\) : ;;/);
    assert.match(body, /require\('semver'\)\.satisfies/);
    assert.match(body, /if \[ -n "\$BAD" \]; then[\s\S]*?exit 1/);
  });
});

describe("publish.yml — publish steps are rerunnable after partial failures", () => {
  it("skips the root package when the exact version already exists on npm", () => {
    const start = EXECUTED.indexOf("Publish to npm with provenance");
    const end = EXECUTED.indexOf("Publish the adapter SDK and first-party plugins");
    assert.ok(start >= 0, "publish.yml no longer has the root npm publish step");
    assert.ok(end > start, "publish.yml root publish step is no longer before workspace publish");

    const step = EXECUTED.slice(start, end);
    const lookup = step.indexOf('npm view "$name@$version" version');
    const publish = step.indexOf('npm publish --provenance --access public --tag "$DIST_TAG"');

    assert.ok(lookup >= 0, "root publish must check whether name@version already exists");
    assert.ok(publish > lookup, "root publish must check npm before publishing");
    assert.match(step, /already on npm/);
  });
});

describe("publish.yml — published versions bind to the source tree", () => {
  it("checks registry versions before any publish", () => {
    const guard = EXECUTED.indexOf("node scripts/verify-published-versions.mjs");
    const publish = EXECUTED.indexOf("Publish to npm with provenance");
    assert.ok(guard >= 0 && guard < publish);
  });

  it("refuses reused root and changed workspace versions, but permits an exact rerun", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-publish-guard-"));
    try {
      const { first, second, binDir } = createPublishFixture(root);
      const run = (state: Record<string, string>) => runPublishGuard(root, binDir, state);

      const reusedRoot = run({ "kit-fixture@1.1.0": first });
      assert.equal(reusedRoot.status, 1, reusedRoot.stderr);
      assert.match(reusedRoot.stderr, /different commit/);

      const changedWorkspace = run({ "kit-plugin-demo@0.1.0": first });
      assert.equal(changedWorkspace.status, 1, changedWorkspace.stderr);
      assert.match(changedWorkspace.stderr, /changed since publication/);

      const exactRerun = run({ "kit-fixture@1.1.0": second, "kit-plugin-demo@0.1.0": second });
      assert.equal(exactRerun.status, 0, exactRerun.stderr);

      const offline = run({ "kit-fixture@1.1.0": "offline" });
      assert.equal(offline.status, 1, offline.stderr);
      assert.match(offline.stderr, /registry lookup failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("publish.yml — release evidence describes the shipped package", () => {
  it("scans the unpacked npm tarball for both SBOM formats", () => {
    const pack = EXECUTED.slice(
      EXECUTED.indexOf("Pack the tarball to attest"),
      EXECUTED.indexOf("Generate GitHub artifact attestation"),
    );
    assert.match(pack, /tar -xzf "\$TARBALL" -C \.release-package/);
    for (const name of ["Generate SBOM (CycloneDX)", "Generate SBOM (SPDX)"]) {
      const start = EXECUTED.indexOf(name);
      const end = EXECUTED.indexOf("\n      - name:", start + name.length);
      const step = EXECUTED.slice(start, end < 0 ? undefined : end);
      assert.match(step, /path:\s*\.release-package\/package/);
      assert.doesNotMatch(step, /path:\s*\.\s*$/m);
    }
  });

  it("does not pack or attest after a failed publish", () => {
    for (const name of ["Pack the tarball to attest", "Generate GitHub artifact attestation"]) {
      const start = EXECUTED.indexOf(name);
      const end = EXECUTED.indexOf("\n      - name:", start + name.length);
      const step = EXECUTED.slice(start, end < 0 ? undefined : end);
      assert.doesNotMatch(step, /\bif:\s*always\(\)/);
    }
  });
});
