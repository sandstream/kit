// Cross-platform "restrict to the current user" for secret files/dirs (#43).
//
// POSIX uses mode bits (0o600 / 0o700). On native Windows (NTFS) those bits are
// no-ops — `fs.chmod` doesn't restrict access — so a secret file written with
// `{ mode: 0o600 }` is still readable by other accounts. There we use `icacls`:
// strip inherited ACLs (`/inheritance:r`) and grant ONLY the current user, so the
// file/dir is genuinely owner-only. Best-effort + fail-soft: a missing icacls or
// unknown user never throws (the caller's write already happened).
import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";

function currentWindowsUser(): string | null {
  // DOMAIN\\user is the most specific grant target; fall back to bare username.
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  if (!user) return null;
  return domain ? `${domain}\\${user}` : user;
}

/** Restrict a secret FILE to the current user (0o600 on POSIX; icacls on Windows). */
export function secureFile(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const user = currentWindowsUser();
  if (!user) return;
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch {
    // best-effort — icacls absent / restricted shell
  }
}

/** Restrict a secret DIR to the current user (0o700 on POSIX; icacls (OI)(CI) on Windows). */
export function secureDir(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    return;
  }
  const user = currentWindowsUser();
  if (!user) return;
  try {
    // (OI)(CI) = object- + container-inherit, so files created later inherit owner-only.
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], {
      stdio: "ignore",
    });
  } catch {
    // best-effort
  }
}
