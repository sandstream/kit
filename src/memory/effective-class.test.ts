import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  effectiveMemoryClass,
  formatClassResolution,
  MEMORY_CLASS_ENV,
} from "./effective-class.js";

// effectiveMemoryClass is the wire that did not exist: resolveMemoryClass had zero
// production callers, so `[memory] default_class` and KIT_MEMORY_CLASS were inert while
// their unit tests passed. These cover the impure half — env and config actually
// reaching the policy.

const originalEnv = process.env[MEMORY_CLASS_ENV];
const originalCwd = process.cwd();

afterEach(() => {
  if (originalEnv === undefined) delete process.env[MEMORY_CLASS_ENV];
  else process.env[MEMORY_CLASS_ENV] = originalEnv;
  process.chdir(originalCwd);
});

function projectWith(toml: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-memclass-"));
  if (toml !== null) writeFileSync(join(dir, ".kit.toml"), toml, "utf-8");
  return dir;
}

describe("effectiveMemoryClass", () => {
  it("falls back to the documented default when nothing is set", async () => {
    const dir = projectWith(null);
    try {
      delete process.env[MEMORY_CLASS_ENV];
      process.chdir(dir);
      const r = await effectiveMemoryClass();
      assert.equal(r.cls, "internal");
      assert.equal(r.source, "default");
      assert.equal(r.recognized, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads [memory] default_class from the project's .kit.toml", async () => {
    const dir = projectWith('[memory]\ndefault_class = "restricted"\n');
    try {
      delete process.env[MEMORY_CLASS_ENV];
      process.chdir(dir);
      const r = await effectiveMemoryClass();
      assert.equal(r.cls, "restricted");
      assert.equal(r.source, "config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets the env var override config, per the documented precedence", async () => {
    const dir = projectWith('[memory]\ndefault_class = "restricted"\n');
    try {
      process.env[MEMORY_CLASS_ENV] = "public";
      process.chdir(dir);
      const r = await effectiveMemoryClass();
      assert.equal(r.cls, "public");
      assert.equal(r.source, "env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed to restricted on an invalid env value, and flags it", async () => {
    // A typo must never silently widen disclosure — that is the asymmetry that matters.
    const dir = projectWith(null);
    try {
      process.env[MEMORY_CLASS_ENV] = "publik";
      process.chdir(dir);
      const r = await effectiveMemoryClass();
      assert.equal(r.cls, "restricted");
      assert.equal(r.recognized, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves from env and the default when the config cannot be loaded", async () => {
    const dir = projectWith("this is not valid toml [[[");
    try {
      delete process.env[MEMORY_CLASS_ENV];
      process.chdir(dir);
      const r = await effectiveMemoryClass();
      assert.equal(r.cls, "internal");
      assert.equal(r.recognized, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatClassResolution", () => {
  it("names the env var as the origin", () => {
    assert.equal(
      formatClassResolution({ cls: "public", source: "env", recognized: true }),
      "public (from KIT_MEMORY_CLASS)",
    );
  });

  it("names the config key as the origin", () => {
    assert.equal(
      formatClassResolution({ cls: "restricted", source: "config", recognized: true }),
      "restricted (from [memory] default_class)",
    );
  });

  it("names the built-in default", () => {
    assert.equal(
      formatClassResolution({ cls: "internal", source: "default", recognized: true }),
      "internal (from built-in default)",
    );
  });

  it("says an unrecognized value failed closed, out loud", () => {
    assert.match(
      formatClassResolution({ cls: "restricted", source: "config", recognized: false }),
      /UNRECOGNIZED value, failed closed/,
    );
  });
});
