import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { resolveTotpSecret, TotpSecretUnusableError } from "./elevation-enrollment.js";

// An enrolled secret that cannot be used must stop elevation. Falling back to the
// YES prompt would let a broken file silently remove the second factor.
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
    if (lstatSync(secretPath).isFile()) chmodSync(secretPath, 0o600);
  } catch {
    /* file may be a directory or missing */
  }
  rmSync(home, { recursive: true, force: true });
});

it("returns undefined when no file exists (not enrolled)", async () => {
  assert.equal(await resolveTotpSecret(), undefined);
});

it("returns undefined when the enrollment directory is absent", async () => {
  rmSync(join(home, ".kit"), { recursive: true });
  assert.equal(await resolveTotpSecret(), undefined);
});

it("returns the trimmed secret from a usable file", async () => {
  writeFileSync(secretPath, "ABCDEF234567\n");
  assert.equal(await resolveTotpSecret(), "ABCDEF234567");
});

it("refuses a dangling symlink instead of treating it as absent enrollment", async () => {
  symlinkSync(join(home, "missing-secret"), secretPath);
  await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
});

it("refuses a symlink even when its target contains a usable secret", async () => {
  const target = join(home, "external-secret");
  writeFileSync(target, "ABCDEF234567\n");
  symlinkSync(target, secretPath);
  await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
});

it("refuses a symlink loop", async () => {
  symlinkSync(secretPath, secretPath);
  await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
});

it("refuses a file replaced by a symlink before open", async (t) => {
  writeFileSync(secretPath, "ABCDEF234567\n");
  const target = join(home, "replacement-secret");
  writeFileSync(target, "JBSWY3DPEHPK3PXP\n");
  const open = fs.open;
  const replacement = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    rmSync(secretPath);
    symlinkSync(target, secretPath);
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
    assert.equal(replacement.mock.callCount(), 1);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});

it("refuses an enrolled file that disappears before open", async (t) => {
  writeFileSync(secretPath, "ABCDEF234567\n");
  const open = fs.open;
  const removal = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    rmSync(secretPath);
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
    assert.equal(removal.mock.callCount(), 1);
  } finally {
    removal.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const secret of ["A", "====", "INVALID!"]) {
  it(`refuses an unusable nonempty secret: ${secret}`, async () => {
    writeFileSync(secretPath, secret);
    await assert.rejects(() => resolveTotpSecret(), TotpSecretUnusableError);
  });
}

it("preserves environment-secret precedence over a broken file enrollment", async () => {
  symlinkSync(join(home, "missing-secret"), secretPath);
  process.env.KIT_TOTP_SECRET = "FROM_ENV";
  assert.equal(await resolveTotpSecret(), "FROM_ENV");
});

it("preserves supported lowercase, whitespace and padding in file secrets", async () => {
  writeFileSync(secretPath, "  mz xw6===\n");
  assert.equal(await resolveTotpSecret(), "mz xw6===");
});

it("preserves the verifier's uppercase expansion before counting key symbols", async () => {
  // The existing decoder normalizes this symbol to SS, which contains one key byte.
  writeFileSync(secretPath, "ß\n");
  assert.equal(await resolveTotpSecret(), "ß");
});

it("accepts one decoded key byte without imposing a minimum key strength", async () => {
  writeFileSync(secretPath, "MY======\n");
  assert.equal(await resolveTotpSecret(), "MY======");
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
