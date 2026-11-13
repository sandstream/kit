import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sameIdentity } from "./utils/same-file.js";
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
        `Repair the file, or replace a file or symlink with \`kit auth setup-totp --overwrite\`. ` +
        `If the path is a directory, move the directory aside and keep its contents. ` +
        `Then run \`kit auth setup-totp\` to enroll a new secret. ` +
        `If you enroll a new secret, your old authenticator entry will stop working.`,
      options,
    );
    this.name = "TotpSecretUnusableError";
    this.filePath = filePath;
  }
}

/** Read only the observed regular file, without following a replacement symlink. */
async function readObservedTotpFile(filePath: string, entry: BigIntStats): Promise<string> {
  const { lstat, open } = await import("node:fs/promises");
  // Reject symlink replacement and avoid blocking on a replacement FIFO.
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    // Windows has no O_NOFOLLOW. Check the entry and handle before reading.
    if (
      !opened.isFile() ||
      !current.isFile() ||
      !sameIdentity(entry, opened) ||
      !sameIdentity(current, opened)
    ) {
      throw new TotpSecretUnusableError(filePath, "the file changed before it could be read");
    }
    return await file.readFile("utf-8");
  } finally {
    await file.close();
  }
}

/** Preserve the verifier's supported encoding, but require at least one key byte. */
function usableTotpFileSecret(content: string, filePath: string): string {
  const secret = content.trim();
  if (!secret) throw new TotpSecretUnusableError(filePath, "the file is empty");
  // Match the verifier's normalization. Fewer than two symbols decode to zero key bytes.
  if (secret.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "").length < 2)
    throw new TotpSecretUnusableError(filePath, "the secret contains no key bytes");
  try {
    generateTotp(secret);
  } catch (error) {
    throw new TotpSecretUnusableError(filePath, "invalid base32 secret", { cause: error });
  }
  return secret;
}

/**
 * Resolves the TOTP secret in priority order:
 *   1. `KIT_TOTP_SECRET` env var (overrides everything; useful for CI)
 *   2. `~/.kit/totp-secret` file (created by `kit auth setup-totp`)
 *   3. undefined, only when no file exists (not enrolled). The caller then falls
 *      back to the yes-prompt.
 *
 * An unreadable, invalid or nonregular file, including a symlink, throws
 * `TotpSecretUnusableError`. It is not the same as "not enrolled".
 */
export async function resolveTotpSecret(): Promise<string | undefined> {
  if (process.env.KIT_TOTP_SECRET) return process.env.KIT_TOTP_SECRET;
  const filePath = totpFilePath();
  const { lstat } = await import("node:fs/promises");
  let enrolled = false;
  let content: string;
  try {
    const entry = await lstat(filePath, { bigint: true });
    enrolled = true;
    if (!entry.isFile()) throw new TotpSecretUnusableError(filePath, "not a regular file");
    content = await readObservedTotpFile(filePath, entry);
  } catch (error) {
    if (!enrolled && error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    if (error instanceof TotpSecretUnusableError) throw error;
    const code = error instanceof Error && "code" in error ? String(error.code) : "read failed";
    throw new TotpSecretUnusableError(filePath, code, { cause: error });
  }
  return usableTotpFileSecret(content, filePath);
}
