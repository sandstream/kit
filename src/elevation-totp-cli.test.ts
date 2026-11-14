import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { generateTotp } from "./elevation-totp.js";

type Fixture = ReturnType<typeof createCliContractFixture>;
const source = import.meta.url.endsWith(".ts");
const cli = new URL(source ? "./cli.ts" : "./cli.js", import.meta.url);

async function elevate(fixture: Fixture, answer: () => string) {
  // Use the existing prompt-test TTY convention while running the real CLI entry.
  const bootstrap = `
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, "auth", "elevate"];
    await import(${JSON.stringify(cli.href)});
  `;
  const env = { ...fixture.env };
  delete env.CI;
  delete env.KIT_NON_INTERACTIVE;
  const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
  const child = spawn(process.execPath, [...loader, "--input-type=module", "-e", bootstrap], {
    cwd: fixture.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
  let output = "";
  let answered = false;
  let spawnError: Error | undefined;
  child.on("error", (error) => (spawnError = error));
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (!answered && /Confirm elevation|Enter 6-digit TOTP/.test(output)) {
      answered = true;
      child.stdin.end(`${answer()}\n`);
    }
  });
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const result = await closed;
    assert.ifError(spawnError);
    assert.equal(result.signal, null, output);
    return { ...result, output, answered };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

function assertNoElevation(fixture: Fixture): void {
  for (const path of [
    join(fixture.cwd, ".kit", "elevation.json"),
    join(fixture.env.HOME!, ".kit", "elevation.key"),
    join(fixture.env.HOME!, ".kit", "elevation-authority"),
  ]) {
    assert.equal(existsSync(path), false, `refusal must not create ${path}`);
  }
  const status = fixture.run(["auth", "status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { active: false, state: null });
}

const brokenEnrollments = [
  {
    name: "dangling symlink",
    create: (path: string) => symlinkSync(`${path}.missing`, path),
    answer: () => "YES",
  },
  {
    name: "symlink to a usable secret",
    create: (path: string) => {
      writeFileSync(`${path}.target`, "ABCDEF234567\n");
      symlinkSync(`${path}.target`, path);
    },
    answer: () => generateTotp("ABCDEF234567"),
  },
  { name: "empty file", create: (path: string) => writeFileSync(path, ""), answer: () => "YES" },
  {
    name: "whitespace-only file",
    create: (path: string) => writeFileSync(path, " \n\t\n"),
    answer: () => "YES",
  },
  { name: "directory", create: (path: string) => mkdirSync(path), answer: () => "YES" },
  ...["A", "===="].map((secret) => ({
    name: secret === "A" ? "one-symbol secret" : "padding-only secret",
    create: (path: string) => writeFileSync(path, secret),
    // These nonempty strings decode to zero key bytes in the existing verifier.
    answer: () => generateTotp(""),
  })),
  {
    name: "invalid base32 characters",
    create: (path: string) => writeFileSync(path, "INVALID!"),
    answer: () => "123456",
  },
];

for (const enrollment of brokenEnrollments) {
  it(`CLI refuses ${enrollment.name} without a YES fallback or elevation state`, async (t) => {
    const fixture = createCliContractFixture();
    try {
      const directory = join(fixture.env.HOME!, ".kit");
      mkdirSync(directory);
      enrollment.create(join(directory, "totp-secret"));
      const result = await elevate(fixture, enrollment.answer);
      t.diagnostic(result.output);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /enrolled but unusable/);
      assert.doesNotMatch(result.output, /Confirm elevation|Enter 6-digit TOTP|method=yes-prompt/);
      assert.equal(result.answered, false, "broken enrollment must refuse before asking for input");
      assertNoElevation(fixture);
    } finally {
      fixture.cleanup();
    }
  });
}

it(
  "CLI refuses a symlink to a FIFO without reading its target",
  { skip: process.platform === "win32" ? "POSIX FIFO fixture" : false },
  async (t) => {
    const fixture = createCliContractFixture();
    try {
      const directory = join(fixture.env.HOME!, ".kit");
      mkdirSync(directory);
      const target = join(directory, "secret-pipe");
      const fifo = spawnSync("mkfifo", [target], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(fifo.error);
      assert.equal(fifo.status, 0, fifo.stderr);
      symlinkSync(target, join(directory, "totp-secret"));
      const result = await elevate(fixture, () => "YES");
      t.diagnostic(result.output);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /enrolled but unusable/);
      assert.equal(result.answered, false);
      assert.doesNotMatch(result.output, /Confirm elevation|Enter 6-digit TOTP/);
      assertNoElevation(fixture);
    } finally {
      fixture.cleanup();
    }
  },
);

it(
  "CLI refuses an unreadable enrolled file without a YES fallback or elevation state",
  {
    skip:
      process.platform === "win32"
        ? "file modes do not apply on win32"
        : process.getuid?.() === 0
          ? "root reads files with mode 000"
          : false,
  },
  async (t) => {
    const fixture = createCliContractFixture();
    const path = join(fixture.env.HOME!, ".kit", "totp-secret");
    try {
      mkdirSync(join(fixture.env.HOME!, ".kit"));
      writeFileSync(path, "ABCDEF234567\n", { mode: 0o000 });
      const result = await elevate(fixture, () => "YES");
      t.diagnostic(result.output);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /enrolled but unusable/);
      assert.equal(result.answered, false);
      assert.doesNotMatch(result.output, /Confirm elevation|Enter 6-digit TOTP/);
      assertNoElevation(fixture);
    } finally {
      if (existsSync(path)) chmodSync(path, 0o600);
      fixture.cleanup();
    }
  },
);

it("CLI permits YES confirmation when the enrollment file is truly absent", async (t) => {
  const fixture = createCliContractFixture();
  try {
    const result = await elevate(fixture, () => "YES");
    t.diagnostic(result.output);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Confirm elevation/);
    assert.doesNotMatch(result.output, /Enter 6-digit TOTP/);
    const status = fixture.run(["auth", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.active, true);
    assert.equal(state.state.method, "yes-prompt");
  } finally {
    fixture.cleanup();
  }
});

it("CLI accepts a usable enrollment only with its TOTP code", async (t) => {
  const fixture = createCliContractFixture();
  try {
    const setup = fixture.run(["auth", "setup-totp", "--account", "disposable-test"]);
    assert.equal(setup.status, 0, setup.stderr);
    const secret = readFileSync(join(fixture.env.HOME!, ".kit", "totp-secret"), "utf8").trim();
    const refused = await elevate(fixture, () => "YES");
    t.diagnostic(refused.output);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /Invalid TOTP code/);
    assert.doesNotMatch(refused.output, /Confirm elevation/);
    assertNoElevation(fixture);
    const accepted = await elevate(fixture, () => generateTotp(secret));
    t.diagnostic(accepted.output);
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /Enter 6-digit TOTP/);
    assert.doesNotMatch(accepted.output, /Confirm elevation/);
    const status = fixture.run(["auth", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.active, true);
    assert.equal(state.state.method, "totp");
  } finally {
    fixture.cleanup();
  }
});

it("CLI preserves the environment secret over a broken file enrollment", async (t) => {
  const fixture = createCliContractFixture();
  try {
    const directory = join(fixture.env.HOME!, ".kit");
    mkdirSync(directory);
    symlinkSync(join(directory, "missing"), join(directory, "totp-secret"));
    fixture.env.KIT_TOTP_SECRET = "ABCDEF234567";
    const result = await elevate(fixture, () => generateTotp(fixture.env.KIT_TOTP_SECRET!));
    t.diagnostic(result.output);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /method=totp/);
    assert.doesNotMatch(result.output, /Confirm elevation/);
    const status = fixture.run(["auth", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.active, true);
    assert.equal(state.state.method, "totp");
  } finally {
    fixture.cleanup();
  }
});

it("CLI explains directory recovery and preserves contents through enrollment and revocation", async (t) => {
  const fixture = createCliContractFixture();
  const path = join(fixture.env.HOME!, ".kit", "totp-secret");
  const moved = `${path}.moved-aside`;
  const contents = "Keep this directory content.\n";
  try {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), contents);
    const before = fixture.snapshot();
    const refused = await elevate(fixture, () => "YES");
    t.diagnostic(refused.output);
    assert.equal(refused.code, 1, refused.output);
    assert.equal(refused.answered, false);
    assert.doesNotMatch(refused.output, /Confirm elevation|Enter 6-digit TOTP/);
    assert.deepEqual(fixture.snapshot(), before);
    assertNoElevation(fixture);

    const overwrite = fixture.run(["auth", "setup-totp", "--overwrite"]);
    t.diagnostic(overwrite.stdout + overwrite.stderr);
    assert.equal(overwrite.status, 1, overwrite.stderr);
    assert.deepEqual(fixture.snapshot(), before);
    assertNoElevation(fixture);
    assert.deepEqual(
      {
        elevate: /move the directory aside/i.test(refused.output),
        setup: /move the directory aside/i.test(overwrite.stderr),
      },
      { elevate: true, setup: true },
      "Both refusals must explain moving the directory aside before enrollment",
    );
    assert.match(overwrite.stderr, /Then run `kit auth setup-totp`/);
    assert.doesNotMatch(overwrite.stderr, /re-run with --overwrite/);
    assert.match(overwrite.stderr, /old authenticator entry will stop working/);

    renameSync(path, moved);
    assert.equal(existsSync(path), false);
    const setup = fixture.run(["auth", "setup-totp", "--account", "disposable-test"]);
    assert.equal(setup.status, 0, setup.stderr);
    // Open once and read through the descriptor, so the check and the read see the same file.
    const secretFd = openSync(path, "r");
    let secret: string;
    try {
      assert.equal(fstatSync(secretFd).isFile(), true);
      secret = readFileSync(secretFd, "utf8").trim();
    } finally {
      closeSync(secretFd);
    }
    assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), contents);
    const accepted = await elevate(fixture, () => generateTotp(secret));
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /method=totp/);
    const active = fixture.run(["auth", "status", "--json"]);
    assert.equal(active.status, 0, active.stderr);
    assert.equal(JSON.parse(active.stdout).active, true);
    assert.equal(JSON.parse(active.stdout).state.method, "totp");

    const revoke = fixture.run(["auth", "revoke"]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const inactive = fixture.run(["auth", "status", "--json"]);
    assert.equal(inactive.status, 0, inactive.stderr);
    assert.deepEqual(JSON.parse(inactive.stdout), { active: false, state: null });
    assert.equal(existsSync(join(fixture.cwd, ".kit", "elevation.json")), false);
    assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), contents);
  } finally {
    fixture.cleanup();
  }
});
