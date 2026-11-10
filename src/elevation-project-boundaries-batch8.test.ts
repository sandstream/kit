import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearElevation,
  consumeElevation,
  elevationTtlMinutes,
  enrollTotp,
  grantElevation,
  readElevation,
  requireElevation,
  resolveTotpSecret,
  writeElevation,
} from "./elevation.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const isolatedNames = [
  "HOME",
  "USERPROFILE",
  "KIT_IDENTITY_DIR",
  "KIT_MEMORY_DIR",
  "KIT_MEMORY_DB",
  "KIT_AUDIT_ANCHOR_DIR",
  "KIT_AUDIT_ANCHOR",
  "KIT_READ_ONLY",
  "KIT_ELEVATED",
  "KIT_TOTP_SECRET",
  "KIT_ELEVATION_TTL_MINUTES",
];
let root: string;
let project: string;
let home: string;
let originalCwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(isolatedNames.map((name) => [name, process.env[name]]));
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "kit-elevation-boundary-"));
  project = join(root, "project");
  home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  for (const name of isolatedNames) delete process.env[name];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: "0",
  });
  process.chdir(project);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const name of isolatedNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmTemp(root);
});

describe("elevation project directory binding", { concurrency: false }, () => {
  it("refuses a copied grant in another project while retaining the original approval", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    assert.equal((await requireElevation("rotate", project)).ok, true);
    const other = join(root, "other-project");
    mkdirSync(join(other, ".kit"), { recursive: true });
    copyFileSync(join(project, ".kit/elevation.json"), join(other, ".kit/elevation.json"));
    assert.equal((await requireElevation("rotate", other)).ok, false);
    assert.equal((await requireElevation("rotate", project)).ok, true);
  });

  it("accepts an alias of the same canonical project directory", async () => {
    const alias = join(root, "project-alias");
    symlinkSync(project, alias, "junction");
    await grantElevation("rotate", "yes-prompt", alias);
    assert.equal((await requireElevation("rotate", project)).ok, true);
    assert.equal((await requireElevation("rotate", alias)).ok, true);
    assert.equal((await requireElevation("migrate", project)).ok, false);
  });

  it("retains grant creation for a new project directory and binds the created directory", async () => {
    const newProject = join(root, "new-project");
    await grantElevation("rotate", "yes-prompt", newProject);
    assert.equal((await requireElevation("rotate", newProject)).ok, true);
    assert.equal((await requireElevation("rotate", project)).ok, false);
  });

  it("refuses a copied marker whose project binding was edited to match the destination", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    const other = join(root, "other-project");
    mkdirSync(join(other, ".kit"), { recursive: true });
    const marker = JSON.parse(readFileSync(join(project, ".kit/elevation.json"), "utf8"));
    marker.projectDirectory = realpathSync(other);
    writeFileSync(join(other, ".kit/elevation.json"), JSON.stringify(marker));
    assert.equal((await requireElevation("rotate", other)).ok, false);
    assert.equal((await requireElevation("rotate", project)).ok, true);
  });

  it("requires fresh approval for a correctly signed legacy unbound marker", async () => {
    const state = await grantElevation("rotate", "yes-prompt", project);
    const key = Buffer.from(readFileSync(join(home, ".kit/elevation.key"), "utf8").trim(), "hex");
    // Preserve the old wire contract so this test reaches legacy rejection, not a bad signature.
    const sig = createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
    writeFileSync(join(project, ".kit/elevation.json"), JSON.stringify({ ...state, sig }));
    assert.equal(await readElevation(project), null);
    assert.equal((await requireElevation("rotate", project)).ok, false);
    await grantElevation("rotate", "yes-prompt", project);
    assert.equal((await requireElevation("rotate", project)).ok, true);
  });
});

describe("elevation signing key reads", { concurrency: false }, () => {
  it("refuses a marker with a missing signing key without creating replacement key material", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    const keyPath = join(home, ".kit/elevation.key");
    rmSync(keyPath);
    assert.equal(await readElevation(project), null);
    assert.equal(existsSync(keyPath), false);
    assert.equal((await requireElevation("rotate", project)).ok, false);
    assert.equal(existsSync(keyPath), false);
  });

  it("refuses another machine's marker without creating a key directory in read-only mode", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    process.env.HOME = otherHome;
    process.env.USERPROFILE = otherHome;
    process.env.KIT_READ_ONLY = "1";
    assert.equal(await readElevation(project), null);
    assert.equal((await requireElevation("rotate", project)).ok, false);
    assert.equal(existsSync(join(otherHome, ".kit")), false);
  });
});

describe("elevation concurrent signing key creation", { concurrency: false }, () => {
  it("uses a key completed by another process within the bounded retry window", async () => {
    const keyPath = join(home, ".kit/elevation.key");
    mkdirSync(join(home, ".kit"));
    const key = "a1".repeat(32);
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { open } from "node:fs/promises";
      import { setTimeout } from "node:timers/promises";
      const file = await open(process.argv[1], "wx", 0o600);
      await file.write("a1".repeat(8));
      process.stdout.write("partial\\n");
      await setTimeout(50);
      await file.write("a1".repeat(24));
      await file.close();
    `,
        keyPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(writer, "close");
    try {
      await once(writer.stdout, "data", { signal: AbortSignal.timeout(5_000) });
      await grantElevation("rotate", "yes-prompt", project);
      const [code, signal] = await closed;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(readFileSync(keyPath, "utf8"), key);
      assert.equal((await requireElevation("rotate", project)).ok, true);
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill();
      await closed;
    }
  });
});

describe("elevation signature validation", { concurrency: false }, () => {
  it("refuses a signature made with the empty key that invalid hex would decode to", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    const markerPath = join(project, ".kit/elevation.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    delete marker.sig;
    const sig = createHmac("sha256", Buffer.alloc(0)).update(JSON.stringify(marker)).digest("hex");
    writeFileSync(markerPath, JSON.stringify({ ...marker, sig }));
    const invalidKey = "z".repeat(64);
    const keyPath = join(home, ".kit/elevation.key");
    writeFileSync(keyPath, invalidKey);
    assert.equal(await readElevation(project), null);
    assert.equal((await requireElevation("rotate", project)).ok, false);
    assert.equal(readFileSync(keyPath, "utf8"), invalidKey);
  });

  it("refuses trailing non-hex signature bytes instead of accepting a decoded prefix", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    const markerPath = join(project, ".kit/elevation.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.sig += "junk";
    writeFileSync(markerPath, JSON.stringify(marker));
    assert.equal((await requireElevation("rotate", project)).ok, false);
  });

  for (const malformed of [
    "g".repeat(64),
    "f".repeat(63),
    "f".repeat(65),
    "f".repeat(66),
    "f".repeat(64) + "junk",
  ]) {
    it(`refuses malformed key bytes (${malformed.length} characters, ${malformed[0]}) without repairing the key`, async () => {
      const keyPath = join(home, ".kit/elevation.key");
      mkdirSync(join(home, ".kit"));
      writeFileSync(keyPath, malformed);
      await assert.rejects(
        () =>
          writeElevation(
            {
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              scope: "rotate",
              granter: "test",
              method: "yes-prompt",
            },
            project,
          ),
        /key/i,
      );
      assert.equal((await requireElevation("rotate", project)).ok, false);
      assert.equal(readFileSync(keyPath, "utf8"), malformed);
    });
  }
});

describe("elevation revocation failures", { concurrency: false }, () => {
  it(
    "reports revocation permission failures and retains the grant until removal succeeds",
    {
      skip:
        process.platform === "win32" || process.getuid?.() === 0
          ? "POSIX directory permissions require a non-root process"
          : false,
    },
    async () => {
      await grantElevation("rotate", "yes-prompt", project);
      const directory = join(project, ".kit");
      chmodSync(directory, 0o500);
      try {
        await assert.rejects(() => clearElevation(project), { code: "EACCES" });
        assert.equal((await requireElevation("rotate", project)).ok, true);
      } finally {
        chmodSync(directory, 0o700);
      }
      await clearElevation(project);
      assert.equal((await requireElevation("rotate", project)).ok, false);
      await clearElevation(project);
      assert.equal((await requireElevation("rotate", project)).ok, false);
    },
  );
});

describe("elevation read-only marker writes", { concurrency: false }, () => {
  it("refuses direct marker writes in read-only mode without creating authorization", async () => {
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(
      () =>
        writeElevation(
          {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            scope: "rotate",
            granter: "test",
            method: "yes-prompt",
          },
          project,
        ),
      /read-only/,
    );
    assert.equal((await requireElevation("rotate", project)).ok, false);
    assert.equal(existsSync(join(home, ".kit/elevation.key")), false);
  });

  it("refuses direct marker replacement in read-only mode without widening its scope", async () => {
    const state = await grantElevation("rotate", "yes-prompt", project);
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(() => writeElevation({ ...state, scope: "all" }, project), /read-only/);
    assert.equal((await requireElevation("rotate", project)).ok, true);
    assert.equal((await requireElevation("migrate", project)).ok, false);
  });
});

describe("elevation read-only marker removal", { concurrency: false }, () => {
  it("refuses revocation in read-only mode and preserves existing authorization", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(() => clearElevation(project), /read-only/);
    assert.equal((await requireElevation("rotate", project)).ok, true);
  });

  it("refuses one-shot marker removal in read-only mode and preserves the grant", async () => {
    await grantElevation("purge-history", "yes-prompt", project);
    process.env.KIT_READ_ONLY = "1";
    const result = await consumeElevation("purge-history", project);
    assert.equal(result.ok, false);
    assert.match(result.reason, /read-only/);
    assert.equal((await requireElevation("purge-history", project)).ok, true);
  });
});

describe("elevation read-only enrollment", { concurrency: false }, () => {
  it("refuses new TOTP enrollment in read-only mode", async () => {
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(() => enrollTotp({ accountName: "synthetic" }), /read-only/);
    assert.equal(await resolveTotpSecret(), undefined);
    assert.equal((await requireElevation("rotate", project)).ok, false);
  });

  it("refuses TOTP replacement in read-only mode and preserves the enrolled secret", async () => {
    const enrollment = await enrollTotp({ accountName: "synthetic" });
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(
      () => enrollTotp({ accountName: "synthetic", overwrite: true }),
      /read-only/,
    );
    assert.equal(await resolveTotpSecret(), enrollment.secret);
  });
});

describe("elevation audit safeguards", { concurrency: false }, () => {
  it("records a read-only refusal in the target project instead of the caller's project", async () => {
    const other = join(root, "other-project");
    mkdirSync(other);
    process.env.KIT_READ_ONLY = "1";
    await assert.rejects(() => grantElevation("rotate", "yes-prompt", other), /read-only/);
    const events = readFileSync(join(other, ".kit-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).operation, "read-only-mode-refusal");
    assert.equal(events.at(-1).metadata.refused_operation, "grant-elevation");
    assert.equal(existsSync(join(project, ".kit-audit.jsonl")), false);
    assert.equal((await requireElevation("rotate", other)).ok, false);
  });

  it("refuses an otherwise valid grant when its required audit record cannot be written", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    mkdirSync(join(project, ".kit-audit.jsonl"));
    const result = await requireElevation("rotate", project);
    assert.equal(result.ok, false);
    assert.match(result.reason, /audit-log unavailable/);
  });
});

describe("elevation configured TTL boundaries", { concurrency: false }, () => {
  for (const [configured, minutes] of [
    [undefined, 15],
    ["1", 1],
    ["240", 240],
  ] as const) {
    it(`grants ${minutes} minutes when TTL is ${configured ?? "absent"}`, async () => {
      if (configured !== undefined) process.env.KIT_ELEVATION_TTL_MINUTES = configured;
      assert.equal(elevationTtlMinutes(), minutes);
      const before = Date.now();
      const state = await grantElevation("rotate", "yes-prompt", project);
      const expires = Date.parse(state.expiresAt);
      assert.ok(expires >= before + minutes * 60_000);
      assert.ok(expires <= Date.now() + minutes * 60_000);
      assert.equal((await requireElevation("rotate", project)).ok, true);
    });
  }

  for (const configured of [
    "",
    "0",
    "-1",
    "241",
    "1junk",
    "1.5",
    "1e2",
    " 1",
    "Infinity",
    "999999999999999999999",
  ]) {
    it(`refuses explicit malformed TTL ${JSON.stringify(configured)} without granting access`, async () => {
      process.env.KIT_ELEVATION_TTL_MINUTES = configured;
      await assert.rejects(
        () => grantElevation("rotate", "yes-prompt", project),
        /KIT_ELEVATION_TTL_MINUTES/,
      );
      assert.throws(() => elevationTtlMinutes(), /KIT_ELEVATION_TTL_MINUTES/);
      assert.equal((await requireElevation("rotate", project)).ok, false);
      assert.equal(existsSync(join(home, ".kit/elevation.key")), false);
    });
  }

  it("preserves an existing scoped grant when an invalid TTL refuses its replacement", async () => {
    await grantElevation("rotate", "yes-prompt", project);
    process.env.KIT_ELEVATION_TTL_MINUTES = "0";
    await assert.rejects(
      () => grantElevation("all", "yes-prompt", project),
      /KIT_ELEVATION_TTL_MINUTES/,
    );
    assert.equal((await requireElevation("rotate", project)).ok, true);
    assert.equal((await requireElevation("migrate", project)).ok, false);
  });
});
