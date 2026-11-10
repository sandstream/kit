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

/** The TOTP file exists but cannot serve as a second factor. Elevation must stop. */
export class TotpSecretUnusableError extends Error {
  readonly filePath: string;
  constructor(filePath: string, reason: string, options?: { cause?: unknown }) {
    super(
      `TOTP secret at ${filePath} is enrolled but unusable (${reason}). ` +
        `Elevation is refused so a broken file cannot remove the second factor. ` +
        `Repair the file, or run \`kit auth setup-totp --overwrite\` to enroll a new secret.`,
      options,
    );
    this.name = "TotpSecretUnusableError";
    this.filePath = filePath;
  }
}

/**
 * Resolves the TOTP secret in priority order:
 *   1. `KIT_TOTP_SECRET` env var (overrides everything; useful for CI)
 *   2. `~/.kit/totp-secret` file (created by `kit auth setup-totp`)
 *   3. undefined, only when no file exists (not enrolled). The caller then falls
 *      back to the yes-prompt.
 *
 * A file that exists but is unreadable, empty, whitespace-only or a directory throws
 * `TotpSecretUnusableError`. It is not the same as "not enrolled".
 */
export async function resolveTotpSecret(): Promise<string | undefined> {
  if (process.env.KIT_TOTP_SECRET) return process.env.KIT_TOTP_SECRET;
  const filePath = totpFilePath();
  const { readFile } = await import("node:fs/promises");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const code = error instanceof Error && "code" in error ? String(error.code) : "read failed";
    throw new TotpSecretUnusableError(filePath, code, { cause: error });
  }
  const secret = content.trim();
  if (!secret) throw new TotpSecretUnusableError(filePath, "the file is empty");
  return secret;
}
