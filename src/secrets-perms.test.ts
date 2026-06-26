import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecrets } from "./secrets.js";
import { syncSecrets } from "./secrets-sync.js";
import type { SecretsConfig } from "./config.js";

// Plaintext-secret files must be owner-only (0o600). POSIX mode bits are
// directly assertable; the Windows icacls path is covered by the #43 probe.
const posix = process.platform !== "win32";

const tmpOut = join(tmpdir(), `.kit-perms-${process.pid}.env`);

afterEach(async () => {
  try {
    await unlink(tmpOut);
  } catch {
    /* ignore */
  }
});

describe("secret-file perms (POSIX 0o600)", { skip: !posix }, () => {
  it("generateSecrets writes .env.local as 0o600", async () => {
    process.env._KIT_PERMS = "topsecret";
    try {
      const config: SecretsConfig = { keys: { _KIT_PERMS: { source: "env" } } };
      const { written } = await generateSecrets(config, tmpOut);
      assert.equal(written, true);
      assert.equal(statSync(tmpOut).mode & 0o777, 0o600);
    } finally {
      delete process.env._KIT_PERMS;
    }
  });

  it("syncSecrets dotenv-ci writes .env.ci as 0o600", async () => {
    process.env._KIT_CI_PERMS = "cisecret";
    try {
      const config: SecretsConfig = { keys: { _KIT_CI_PERMS: { source: "env" } } };
      const res = await syncSecrets(config, { target: "dotenv-ci", projectPath: tmpdir() });
      const ciPath = join(tmpdir(), ".env.ci");
      try {
        assert.ok(res.synced.includes("_KIT_CI_PERMS"));
        assert.equal(statSync(ciPath).mode & 0o777, 0o600);
      } finally {
        await unlink(ciPath).catch(() => {});
      }
    } finally {
      delete process.env._KIT_CI_PERMS;
    }
  });
});
