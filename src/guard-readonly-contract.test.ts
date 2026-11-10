import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { generateShim, SHIM_MARKER } from "./guard.js";

let fixture: ReturnType<typeof createCliContractFixture>;
let shims: string;
let log: string;

beforeEach(() => {
  fixture = createCliContractFixture();
  shims = join(fixture.root, "shims");
  log = join(fixture.root, "observations.jsonl");
  fixture.env.KIT_GUARD_DIR = shims;
  fixture.env.KIT_GUARD_LOG = log;
  mkdirSync(shims);
});
afterEach(() => fixture.cleanup());

const clone = ["git", "clone", "https://github.com/example/guard-readonly-fixture.git"];
const install = ["npm", "install", "kit-contract-fixture@1.0.0"];
const stale = `#!/bin/sh\n${SHIM_MARKER}\n# Older kit version\nexit 0\n`;

function seedShim(tool: string, body = stale): string {
  const path = join(shims, tool);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function protectedState() {
  const state = fixture.snapshot();
  delete state["observations.jsonl"];
  delete state[join("project", ".kit-audit.jsonl")];
  // Expected: the permitted audit write also uses one persistent coordination file.
  const lockPath = join("project", ".kit-audit.jsonl.lock.sqlite");
  if (Object.hasOwn(state, lockPath)) {
    const lock = lstatSync(join(fixture.root, lockPath));
    assert.ok(lock.isFile());
    assert.equal(lock.nlink, 1);
    delete state[lockPath];
  }
  return Object.fromEntries(
    Object.entries(state).map(([path, content]) => [
      path,
      createHash("sha256").update(content).digest("hex"),
    ]),
  );
}

function assertObservation(args: string[], command: string[]) {
  const result = fixture.run([...args, ...command]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const rows = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  const observation = JSON.parse(rows[0]) as {
    tool: string;
    command: string;
    cwd: string;
    wouldBlock: boolean;
    reason: string;
  };
  assert.equal(observation.tool, command[0]);
  assert.equal(observation.command, command.join(" "));
  assert.equal(observation.cwd, realpathSync(fixture.cwd));
  assert.equal(typeof observation.wouldBlock, "boolean");
  return observation;
}

const modes = [
  { name: "leading --read-only", args: ["--read-only", "guard-observe", "--"] },
  { name: "command --read-only", args: ["guard-observe", "--read-only", "--"] },
  { name: "KIT_READ_ONLY=1", args: ["guard-observe"], env: "1" },
  { name: "target policy", args: ["guard-observe"], policy: true },
  { name: "target policy with KIT_READ_ONLY=0", args: ["guard-observe"], policy: true, env: "0" },
  {
    name: "target policy with KIT_READ_ONLY=false",
    args: ["guard-observe"],
    policy: true,
    env: "false",
  },
];

function activate(mode: (typeof modes)[number]) {
  if (mode.env !== undefined) fixture.env.KIT_READ_ONLY = mode.env;
  if (mode.policy) {
    writeFileSync(
      join(fixture.cwd, ".kit.toml"),
      'version = 1\n[policy]\ndefault_mode = "read-only"\n',
    );
  }
}

for (const mode of modes) {
  it(`${mode.name} preserves an installed stale shim while recording an observation`, () => {
    activate(mode);
    const shim = seedShim("git");
    const before = protectedState();
    const identity = statSync(shim);
    assert.equal(assertObservation(mode.args, clone).wouldBlock, false);
    assert.equal(
      readFileSync(shim, "utf8"),
      stale,
      "read-only must not refresh the installed shim",
    );
    const after = statSync(shim);
    assert.equal(after.ino, identity.ino, "read-only must not replace the shim inode");
    assert.equal(after.mtimeMs, identity.mtimeMs);
    assert.equal(after.mode, identity.mode);
    assert.deepEqual(protectedState(), before, "only observation and audit logs may change");
  });

  it(`${mode.name} records an install observation without provisioning tools`, () => {
    activate(mode);
    seedShim("npm", generateShim("npm", shims));
    const before = protectedState();
    const observation = assertObservation(mode.args, install);
    assert.equal(observation.wouldBlock, true, "skipped triage must not imply a verified install");
    assert.match(observation.reason, /read-only mode active; triage skipped/);
    assert.deepEqual(protectedState(), before, "observation must not provision triage or tools");
  });
}

it("refreshes only the observed stale shim when writes are allowed", () => {
  const shim = seedShim("git");
  const other = seedShim("npm");
  assertObservation(["guard-observe"], clone);
  assert.equal(readFileSync(shim, "utf8"), generateShim("git", shims));
  assert.equal(readFileSync(other, "utf8"), stale);
});

it("does not treat an observed tool's --read-only as a Kit flag", () => {
  const shim = seedShim("git");
  assertObservation(["guard-observe"], [...clone, "--read-only"]);
  assert.equal(readFileSync(shim, "utf8"), generateShim("git", shims));
});

it("preserves the parser's refusal reason without provisioning tools in read-only mode", () => {
  fixture.env.KIT_READ_ONLY = "1";
  const before = protectedState();
  const observation = assertObservation(
    ["guard-observe"],
    [...install, "--registry=https://registry.example.invalid"],
  );
  assert.equal(observation.wouldBlock, true);
  assert.match(observation.reason, /cannot reduce to a triage target/);
  assert.doesNotMatch(observation.reason, /triage skipped/);
  assert.deepEqual(protectedState(), before);
});

it("keeps a local runner observation allowed without provisioning tools in read-only mode", () => {
  fixture.env.KIT_READ_ONLY = "1";
  const bin = join(fixture.cwd, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "fixture-runner"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const before = protectedState();
  const observation = assertObservation(["guard-observe"], ["npx", "fixture-runner"]);
  assert.equal(observation.wouldBlock, false);
  assert.equal(observation.reason, "no registry targets to triage");
  assert.deepEqual(protectedState(), before);
});
