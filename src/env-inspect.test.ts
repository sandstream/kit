import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnvFile, redactValue, inspectEnv } from "./env-inspect.js";

describe("parseEnvFile", () => {
  it("parses simple key=value pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    assert.equal(result.FOO, "bar");
    assert.equal(result.BAZ, "qux");
  });

  it("ignores blank lines and comments", () => {
    const result = parseEnvFile("# comment\n\nFOO=bar\n# another comment\n");
    assert.equal(result.FOO, "bar");
    assert.equal(Object.keys(result).length, 1);
  });

  it("strips double-quoted values", () => {
    const result = parseEnvFile('SECRET="my secret value"');
    assert.equal(result.SECRET, "my secret value");
  });

  it("strips single-quoted values", () => {
    const result = parseEnvFile("SECRET='my secret value'");
    assert.equal(result.SECRET, "my secret value");
  });

  it("keeps values with = signs in them", () => {
    const result = parseEnvFile("TOKEN=abc=def=ghi");
    assert.equal(result.TOKEN, "abc=def=ghi");
  });
});

describe("redactValue", () => {
  it("shows first 4 chars + **** for longer values", () => {
    assert.equal(redactValue("sk-or-v1-abc123"), "sk-o****");
  });

  it("returns **** for values of 4 chars or less", () => {
    assert.equal(redactValue("abc"), "****");
    assert.equal(redactValue("abcd"), "****");
  });

  it("works for empty string", () => {
    assert.equal(redactValue(""), "****");
  });
});

describe("inspectEnv", () => {
  it("returns envLocalExists=false when .env.local is missing", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-1`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await inspectEnv({}, { cwd: tmpDir });
      assert.equal(result.envLocalExists, false);
      assert.equal(result.keys.length, 0);
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("lists keys from .env.local when no secrets config", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-2`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "FOO=bar\nBAZ=qux\n", "utf-8");
    try {
      const result = await inspectEnv({}, { cwd: tmpDir });
      assert.equal(result.envLocalExists, true);
      assert.equal(result.keys.length, 2);
      const fooKey = result.keys.find((k) => k.name === "FOO");
      assert.ok(fooKey);
      assert.equal(fooKey.set, true);
      assert.equal(fooKey.source, ".env.local");
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });

  it("redacts values by default", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-3`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "SECRET=sk-abcdefghij\n", "utf-8");
    try {
      const result = await inspectEnv({}, { cwd: tmpDir });
      const key = result.keys.find((k) => k.name === "SECRET");
      assert.ok(key);
      assert.equal(key.value, undefined, "value should not be exposed by default");
      assert.ok(key.redacted, "redacted should be set");
      assert.ok(key.redacted.endsWith("****"), `redacted should end with ****: ${key.redacted}`);
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });

  it("shows values when showValues=true", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-4`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "SECRET=my-plaintext-value\n", "utf-8");
    try {
      const result = await inspectEnv({}, { cwd: tmpDir, showValues: true });
      const key = result.keys.find((k) => k.name === "SECRET");
      assert.ok(key);
      assert.equal(key.value, "my-plaintext-value");
      assert.equal(key.redacted, undefined);
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });

  it("marks keys from secrets config as not set when absent from .env.local", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-5`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const config = {
        secrets: {
          keys: {
            MISSING_KEY: { source: "1password" as const, ref: "op://Dev/Key" },
          },
        },
      };
      const result = await inspectEnv(config, { cwd: tmpDir });
      assert.equal(result.ok, false);
      const key = result.keys.find((k) => k.name === "MISSING_KEY");
      assert.ok(key);
      assert.equal(key.set, false);
      assert.equal(key.source, "1password");
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("returns ok=true when all config keys are present in .env.local", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-6`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "API_KEY=secret123\n", "utf-8");
    try {
      const config = {
        secrets: {
          keys: {
            API_KEY: { source: "1password" as const, ref: "op://Dev/ApiKey" },
          },
        },
      };
      const result = await inspectEnv(config, { cwd: tmpDir });
      assert.equal(result.ok, true);
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });

  it("filters to only missing keys when missingOnly=true", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-7`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "SET_KEY=value\n", "utf-8");
    try {
      const config = {
        secrets: {
          keys: {
            SET_KEY: { source: "env" as const },
            MISSING_KEY: { source: "env" as const },
          },
        },
      };
      const result = await inspectEnv(config, { cwd: tmpDir, missingOnly: true });
      assert.equal(result.keys.length, 1);
      assert.equal(result.keys[0].name, "MISSING_KEY");
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });

  it("returns sorted keys", async () => {
    const tmpDir = join(tmpdir(), `kit-env-test-${process.pid}-8`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, ".env.local"), "ZEBRA=1\nAPPLE=2\nMIDDLE=3\n", "utf-8");
    try {
      const result = await inspectEnv({}, { cwd: tmpDir });
      const names = result.keys.map((k) => k.name);
      assert.deepEqual(names, [...names].sort());
    } finally {
      await unlink(join(tmpDir, ".env.local"));
      await rmdir(tmpDir);
    }
  });
});
