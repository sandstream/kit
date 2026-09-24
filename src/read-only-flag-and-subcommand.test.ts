import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const adjacentCli = resolve(import.meta.dirname, "cli.js");
const CLI = existsSync(adjacentCli) ? adjacentCli : resolve(import.meta.dirname, "../dist/cli.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ro-flag-sub-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "read-only-flag-sub", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/**
 * RO-1/RO-2/RO-3: the audit found the read-only floor could be bypassed three ways:
 * a `--read-only=<value>` token was never recognized at all (only the bare flag was),
 * a policy-forced read-only mode deferred to KIT_READ_ONLY's raw string presence
 * instead of its truthiness, and an unrecognized subcommand fell through to a
 * command's default (mutating) action instead of erroring.
 */
describe("read-only flag value parsing (RO-1)", () => {
  function flagEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      HOME: home,
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_IDENTITY_DIR: join(home, ".kit"),
      KIT_MEMORY_DIR: join(home, ".kit", "memory"),
    };
    delete env.KIT_READ_ONLY;
    return env;
  }

  it("--read-only=1 refuses a mutation same as bare --read-only", { timeout: 20_000 }, () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-flagval-home-"));
    try {
      const result = spawnSync(process.execPath, [CLI, "fix", "--read-only=1"], {
        cwd: dir,
        encoding: "utf-8",
        env: flagEnv(home),
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /read-only mode active/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--readonly=true refuses a mutation", { timeout: 20_000 }, () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-flagval-home-"));
    try {
      const result = spawnSync(process.execPath, [CLI, "identity", "init", "--readonly=true"], {
        cwd: dir,
        encoding: "utf-8",
        env: flagEnv(home),
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /read-only mode active/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--read-only=0 is a usage error, never a silent no-op", { timeout: 20_000 }, () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-flagval-home-"));
    try {
      const result = spawnSync(process.execPath, [CLI, "check", "--read-only=0"], {
        cwd: dir,
        encoding: "utf-8",
        env: flagEnv(home),
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, 2, output);
      assert.doesNotMatch(output, /read-only mode active/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("KIT_READ_ONLY environment values (RO-4)", () => {
  it("refuses mutations for case-insensitive truthy values", { timeout: 30_000 }, () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-env-home-"));
    try {
      for (const value of ["TRUE", "yes", "On"]) {
        const result = spawnSync(process.execPath, [CLI, "fix"], {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            HOME: home,
            KIT_HIDE_HOOK_SKIP_BANNER: "1",
            KIT_IDENTITY_DIR: join(home, ".kit"),
            KIT_MEMORY_DIR: join(home, ".kit", "memory"),
            KIT_READ_ONLY: value,
          },
          timeout: 10_000,
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        assert.equal(result.status, 1, `${value}: ${output}`);
        assert.match(output, /read-only mode active/, value);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("read-only global flags on a command without a subcommand (RO-6)", () => {
  it("shows baseline usage instead of treating --read-only as a subcommand", () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-baseline-home-"));
    try {
      for (const args of [
        ["--read-only", "baseline"],
        ["baseline", "--read-only"],
      ]) {
        const result = spawnSync(process.execPath, [CLI, ...args], {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            HOME: home,
            KIT_HIDE_HOOK_SKIP_BANNER: "1",
            KIT_IDENTITY_DIR: join(home, ".kit"),
            KIT_MEMORY_DIR: join(home, ".kit", "memory"),
          },
          timeout: 10_000,
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        assert.equal(result.status, 0, output);
        assert.match(output, /kit baseline.*freeze current warnings/s);
        assert.doesNotMatch(output, /Unknown subcommand/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("policy default_mode forces read-only regardless of KIT_READ_ONLY value (RO-2)", () => {
  it("KIT_READ_ONLY=0 does not override a read-only policy", { timeout: 20_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ro-policy-"));
    const home = mkdtempSync(join(tmpdir(), "kit-ro-policy-home-"));
    try {
      writeFileSync(
        join(dir, ".kit.toml"),
        'version = 1\n\n[policy]\ndefault_mode = "read-only"\n',
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "read-only-policy", version: "1.0.0", private: true }) + "\n",
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "true",
        HOME: home,
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        KIT_IDENTITY_DIR: join(home, ".kit"),
        KIT_MEMORY_DIR: join(home, ".kit", "memory"),
        KIT_READ_ONLY: "0",
      };
      const result = spawnSync(process.execPath, [CLI, "fix"], {
        cwd: dir,
        encoding: "utf-8",
        env,
        timeout: 10_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /read-only mode active/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("unknown subcommand never falls through to a default write (RO-3)", () => {
  it("`secrets zzz` is a usage error, not secret generation", { timeout: 20_000 }, () => {
    const dir = project();
    try {
      const result = spawnSync(process.execPath, [CLI, "secrets", "zzz"], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, CI: "true" },
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(join(dir, ".env.local")), ".env.local must not be written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "`--read-only secrets zzz` is refused before reaching the handler",
    { timeout: 20_000 },
    () => {
      const dir = project();
      const home = mkdtempSync(join(tmpdir(), "kit-ro-unknown-sub-home-"));
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CI: "true",
          HOME: home,
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
          KIT_IDENTITY_DIR: join(home, ".kit"),
          KIT_MEMORY_DIR: join(home, ".kit", "memory"),
        };
        delete env.KIT_READ_ONLY;
        const result = spawnSync(process.execPath, [CLI, "secrets", "zzz", "--read-only"], {
          cwd: dir,
          encoding: "utf-8",
          env,
          timeout: 10_000,
        });
        assert.notEqual(result.status, 0);
        assert.ok(!existsSync(join(dir, ".env.local")));
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "`check zzz --attest` is a usage error, no attestation key minted",
    { timeout: 20_000 },
    () => {
      const dir = project();
      const home = mkdtempSync(join(tmpdir(), "kit-ro-unknown-check-home-"));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", HOME: home };
        const result = spawnSync(process.execPath, [CLI, "check", "zzz", "--attest", "--json"], {
          cwd: dir,
          encoding: "utf-8",
          env,
          timeout: 20_000,
        });
        assert.notEqual(result.status, 0);
        assert.ok(!existsSync(join(home, ".kit", "audit-anchor.key")));
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
