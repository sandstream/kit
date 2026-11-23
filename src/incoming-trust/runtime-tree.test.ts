import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { secureDirStrict } from "../utils/secure-perms.js";
import { captureIncomingCandidate } from "./candidate-flow.js";
import { launchIncomingCandidate } from "./launch-candidate.js";
import { launchFixture, NATIVE_RUN_TEST_WINDOW_MS } from "./launch-candidate.test-support.js";
import { withHttps } from "./npm-artifact-fetch.test-support.js";
import { archive, type Entry } from "./npm-artifact-archive.test-support.js";
import { hasNativeImageTool } from "./native-image.test-support.js";
import {
  materializeRunTree,
  readApprovedRunTree,
  verifyMaterializedRunTree,
} from "./runtime-tree.js";
import { snapshotFixture } from "./snapshot.test-support.js";

function pack(
  name: string,
  code: string,
  dependencies?: Record<string, string>,
  extra: Entry[] = [],
): Buffer {
  const manifest = {
    name,
    version: "1.0.0",
    main: "index.js",
    dependencies,
    scripts: { install: "node install.js" },
  };
  return archive([
    { path: "package/package.json", body: JSON.stringify(manifest) },
    { path: "package/index.js", body: code },
    { path: "package/install.js", body: 'throw new Error("install must not run")' },
    { path: "package/empty", dir: true },
    ...extra,
  ]);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function packageFixture(extra: Entry[] = []) {
  const dependencies = { leaf: "1.0.0" };
  const outer = pack(
    "@scope/real",
    'module.exports = "locked " + require("leaf");',
    dependencies,
    extra,
  );
  const leaf = pack("leaf", 'module.exports = "nested dependency";');
  const expectations = [
    {
      packagePath: "node_modules/compat",
      name: "@scope/real",
      version: "1.0.0",
      sha256: sha256(outer),
    },
    {
      packagePath: "node_modules/compat/node_modules/leaf",
      name: "leaf",
      version: "1.0.0",
      sha256: sha256(leaf),
    },
  ];
  return { dependencies, outer, leaf, expectations };
}

function capturePackages(source: string, destination: string, fixture = packageFixture()) {
  const { dependencies, outer, leaf } = fixture;
  const integrity = (bytes: Buffer) =>
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  return withHttps(
    (request, response) => response.end(request.url === "/outer.tgz" ? outer : leaf),
    ({ origin, caPem }) => {
      const manifest = {
        name: "run-fixture",
        version: "1.0.0",
        type: "module",
        dependencies: { compat: "npm:@scope/real@1.0.0" },
      };
      const packages = {
        "": manifest,
        "node_modules/compat/node_modules/leaf": {
          version: "1.0.0",
          resolved: origin + "/leaf.tgz",
          integrity: integrity(leaf),
        },
        "node_modules/compat": {
          name: "@scope/real",
          version: "1.0.0",
          resolved: origin + "/outer.tgz",
          integrity: integrity(outer),
          dependencies,
        },
      };
      writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
      writeFileSync(
        join(source, "package-lock.json"),
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          packages,
        }),
      );
      return captureIncomingCandidate({
        source,
        destination,
        fetchPolicy: { origins: [origin], caPem },
      });
    },
  );
}

it(
  "runs retained aliased and nested npm packages offline through the signed CLI",
  {
    skip: !hasNativeImageTool || process.arch !== "arm64",
  },
  async () => {
    const fixture = packageFixture();
    const f = await launchFixture(
      () =>
        'import fs from "node:fs"; import value from "compat"; fs.writeFileSync("answer",value);',
      5000,
      undefined,
      (source, destination) => capturePackages(source, destination, fixture),
      fixture.expectations,
    );
    try {
      const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
      const report = join(f.root, "report.json");
      const policy = join(f.root, "policy.json");
      writeFileSync(report, JSON.stringify(f.verification));
      writeFileSync(policy, JSON.stringify(f.policy));
      const run = () =>
        spawnSync(
          process.execPath,
          [
            cli,
            "security",
            "incoming",
            "run",
            "--repo",
            f.repository,
            "--store",
            f.directory,
            "--snapshot-dir",
            f.source,
            "--verification",
            report,
            "--policy",
            policy,
            "--json",
          ],
          {
            cwd: f.repository,
            encoding: "utf8",
            timeout: NATIVE_RUN_TEST_WINDOW_MS,
            env: { ...process.env, KIT_READ_ONLY: "0" },
          },
        );
      const retained = join(f.source, "artifacts", "0.tgz");
      const original = readFileSync(retained);
      writeFileSync(retained, pack("leaf", 'module.exports = "wrong bytes";'));
      const changed = run();
      assert.equal(changed.status, 1, changed.stderr);
      assert.deepEqual(JSON.parse(changed.stdout), { ran: false, reason: "candidate-changed" });
      assert.equal(existsSync(f.policy.outputDirectory), false);
      writeFileSync(retained, original);

      const accepted = run();
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      const receipt = JSON.parse(accepted.stdout) as { inputDigest: string };
      assert.match(receipt.inputDigest, /^[a-f0-9]{64}$/);
      const originalTree = f.verification.checks.find(({ id }) => id === "snapshot");
      assert.ok(originalTree);
      assert.notEqual(receipt.inputDigest, originalTree.evidenceDigest);
      assert.equal(
        readFileSync(join(f.policy.outputDirectory, "answer"), "utf8"),
        "locked nested dependency",
      );
    } finally {
      f.cleanup();
    }
  },
);

it("detects a change to a derived package file even when its package version matches", async () => {
  const f = snapshotFixture();
  try {
    const fixture = packageFixture();
    const staged = await capturePackages(f.source, f.destination, fixture);
    assert.equal(staged.status, "bound", JSON.stringify(staged));
    const approved = readApprovedRunTree(f.destination, fixture.expectations);
    assert.ok(approved.ok, JSON.stringify(approved));
    const workspace = join(f.root, "runtime");
    mkdirSync(workspace, { mode: 0o700 });
    secureDirStrict(workspace);
    const built = materializeRunTree(approved.tree, workspace);
    assert.equal(verifyMaterializedRunTree(built.tree, built.manifest), true);
    writeFileSync(
      join(built.tree, "node_modules/compat/node_modules/leaf/index.js"),
      'module.exports = "different runtime bytes";',
    );
    assert.equal(verifyMaterializedRunTree(built.tree, built.manifest), false);
  } finally {
    f.cleanup();
  }
});

it("refuses colliding implicit package directories while deriving the run tree", async () => {
  const f = snapshotFixture();
  try {
    const fixture = packageFixture([
      { path: "package/lib/one.js", body: "1" },
      { path: "package/Lib/two.js", body: "2" },
    ]);
    const staged = await capturePackages(f.source, f.destination, fixture);
    assert.equal(staged.status, "bound", JSON.stringify(staged));
    const approved = readApprovedRunTree(f.destination, fixture.expectations);
    assert.ok(approved.ok, JSON.stringify(approved));
    const workspace = join(f.root, "runtime");
    mkdirSync(workspace, { mode: 0o700 });
    secureDirStrict(workspace);
    assert.throws(() => materializeRunTree(approved.tree, workspace), /path collides/);
  } finally {
    f.cleanup();
  }
});

it(
  "refuses a signed candidate whose lock and tarball agree but differ from the policy's independent bytes",
  {
    skip: !hasNativeImageTool || process.arch !== "arm64",
  },
  async () => {
    const fixture = packageFixture();
    const alternate = { ...fixture, leaf: pack("leaf", 'module.exports = "replacement bytes";') };
    const f = await launchFixture(
      () => 'throw new Error("this entry is never loaded");',
      5000,
      undefined,
      (source, destination) => capturePackages(source, destination, alternate),
      fixture.expectations,
    );
    try {
      assert.deepEqual(launchIncomingCandidate(f), {
        ran: false,
        reason: "run-npm-expectations-mismatch",
      });
      assert.equal(existsSync(f.policy.outputDirectory), false);
    } finally {
      f.cleanup();
    }
  },
);
