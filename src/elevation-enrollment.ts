import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { secureFileStrict } from "./utils/secure-perms.js";
import { buildOtpAuthUri, generateBase32Secret, generateTotp } from "./elevation-totp.js";

function totpFilePath(): string {
  return join(homedir(), ".kit", "totp-secret");
}

export interface EnrolledSecret {
  secret: string;
  filePath: string;
  uri: string;
  currentCode: string;
}

export async function enrollTotp(opts: {
  accountName: string;
  issuer?: string;
  overwrite?: boolean;
}): Promise<EnrolledSecret> {
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite(
      "enroll-totp",
      { overwrite: opts.overwrite ?? false },
      { cwd: process.cwd() },
    );
    throw new Error(refusal.reason);
  }
  const { writeFile, mkdir, link, rename, rm } = await import("node:fs/promises");
  const filePath = totpFilePath();

  const secret = generateBase32Secret(20);
  const uri = buildOtpAuthUri({
    accountName: opts.accountName,
    issuer: opts.issuer,
    secret,
  });

  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, secret + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" });
    secureFileStrict(temporary);
    if (opts.overwrite) {
      await rename(temporary, filePath);
    } else {
      // Publish complete bytes without replacing another process's enrollment.
      try {
        await link(temporary, filePath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        throw new Error(
          `TOTP secret already enrolled at ${filePath}. Pass overwrite=true to replace it (your old authenticator entry will stop working).`,
          { cause: error },
        );
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }

  return {
    secret,
    filePath,
    uri,
    currentCode: generateTotp(secret),
  };
}

/**
 * Resolves the TOTP secret in priority order:
 *   1. `KIT_TOTP_SECRET` env var (overrides everything; useful for CI)
 *   2. `~/.kit/totp-secret` file (created by `kit auth setup-totp`)
 *   3. undefined. caller falls back to yes-prompt
 */
export async function resolveTotpSecret(): Promise<string | undefined> {
  if (process.env.KIT_TOTP_SECRET) return process.env.KIT_TOTP_SECRET;
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(totpFilePath(), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}
