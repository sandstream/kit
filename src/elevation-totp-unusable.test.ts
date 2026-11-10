import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveTotpSecret, TotpSecretUnusableError } from "./elevation-enrollment.js";

// An enrolled secret that cannot be used must stop elevation. Falling back to the
// YES prompt would let a broken file silently remove the second factor.
describe("resolveTotpSecret with an enrolled but unusable file", { concurrency: false }, () => {
  let home: string;
  let secretPath: string;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KIT_TOTP_SECRET: process.env.KIT_TOTP_SECRET,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kit-totp-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.KIT_TOTP_SECRET;
    mkdirSync(join(home, ".kit"), { recursive: true });
    secretPath = join(home, ".kit", "totp-secret");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      /* file may be a directory or missing */
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("returns undefined when no file exists (not enrolled)", async () => {
    assert.equal(await resolveTotpSecret(), undefined);
  });

  it("returns the trimmed secret from a usable file", async () => {
    writeFileSync(secretPath, "ABCDEF234567\n");
    assert.equal(await resolveTotpSecret(), "ABCDEF234567");
  });

  it("refuses an empty file and names it", async () => {
    writeFileSync(secretPath, "");
    await assert.rejects(
      () => resolveTotpSecret(),
      (error: unknown) => {
        assert.ok(error instanceof TotpSecretUnusableError);
        assert.ok((error as Error).message.includes(secretPath));
        return true;
      },
    );
  });

  it("refuses a whitespace-only file", async () => {
    writeFileSync(secretPath, " \n\t\n");
    await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
  });

  it("refuses a directory at the secret path", async () => {
    mkdirSync(secretPath);
    await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
  });

  it(
    "refuses a file that exists but cannot be read",
    {
      skip:
        process.platform === "win32"
          ? "file modes do not apply on win32"
          : process.getuid?.() === 0
            ? "root reads files with mode 000"
            : false,
    },
    async () => {
      writeFileSync(secretPath, "ABCDEF234567\n");
      chmodSync(secretPath, 0o000);
      await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
    },
  );
});
