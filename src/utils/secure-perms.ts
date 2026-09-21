// Cross-platform "restrict to the current user" for sensitive files and directories.
//
// Ordinary helpers are fail-soft because many callers protect data only after a successful
// write. Authority-bearing callers use strict variants and verify the ACL before trusting a
// local marker.
import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const WINDOWS_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:KIT_PRIVATE_ACL_PATH
$kind = $env:KIT_PRIVATE_ACL_KIND
$repair = $env:KIT_PRIVATE_ACL_REPAIR -eq '1'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($repair) {
  $acl = Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
  $acl.SetOwner($sid)
  if ($kind -eq 'dir') {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  } else {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  }
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$acl = Get-Acl -LiteralPath $path
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$entries = @($acl.Access)
$valid = $acl.AreAccessRulesProtected -and $owner -eq $sid.Value -and $entries.Count -eq 1
if ($valid) {
  $entry = $entries[0]
  $entrySid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $valid = -not $entry.IsInherited -and
    $entrySid -eq $sid.Value -and
    $entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (($entry.FileSystemRights -band $full) -eq $full)
}
if (-not $valid) { exit 3 }
Write-Output 'PRIVATE'
`;

type PrivatePathKind = "file" | "dir";

function windowsAcl(path: string, kind: PrivatePathKind, repair: boolean): boolean {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    if (repair) throw new Error("Cannot establish Windows ACL: SystemRoot is unavailable");
    return false;
  }
  // Absolute system path avoids PATH search for an authority-bearing subprocess.
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(WINDOWS_PRIVATE_ACL, "utf16le").toString("base64");
  try {
    const output = execFileSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        env: {
          ...process.env,
          KIT_PRIVATE_ACL_PATH: path,
          KIT_PRIVATE_ACL_KIND: kind,
          KIT_PRIVATE_ACL_REPAIR: repair ? "1" : "0",
        },
      },
    );
    if (output.trim() === "PRIVATE") return true;
  } catch (err) {
    if (repair)
      throw new Error(`Cannot establish owner-only Windows ACL for ${path}`, { cause: err });
    return false;
  }
  if (repair) throw new Error(`Cannot verify owner-only Windows ACL for ${path}`);
  return false;
}

function posixPathIsControlled(path: string, kind: PrivatePathKind): boolean {
  const info = statSync(path, { bigint: true });
  const uid = process.getuid?.();
  return (
    (kind === "file" ? info.isFile() : info.isDirectory()) &&
    (info.mode & 0o022n) === 0n &&
    (uid === undefined || info.uid === BigInt(uid))
  );
}

function securePrivatePath(path: string, kind: PrivatePathKind): void {
  if (process.platform === "win32") windowsAcl(path, kind, true);
  else chmodSync(path, kind === "file" ? 0o600 : 0o700);
}

function privatePathIsControlled(path: string, kind: PrivatePathKind): boolean {
  try {
    return process.platform === "win32"
      ? windowsAcl(path, kind, false)
      : posixPathIsControlled(path, kind);
  } catch {
    return false;
  }
}

/** Establish owner-only access or throw. Used where filesystem integrity grants authority. */
export function secureFileStrict(path: string): void {
  securePrivatePath(path, "file");
}

/** Establish owner-only directory access or throw. */
export function secureDirStrict(path: string): void {
  securePrivatePath(path, "dir");
}

export function privateFileIsControlled(path: string): boolean {
  return privatePathIsControlled(path, "file");
}

export function privateDirIsControlled(path: string): boolean {
  return privatePathIsControlled(path, "dir");
}

/** Restrict a sensitive file; fail-soft for callers whose primary write already succeeded. */
export function secureFile(path: string): void {
  try {
    secureFileStrict(path);
  } catch {
    // Authority-bearing callers use secureFileStrict and fail closed.
  }
}

/** Restrict a sensitive directory; fail-soft for ordinary storage hardening. */
export function secureDir(path: string): void {
  try {
    secureDirStrict(path);
  } catch {
    // Authority-bearing callers use secureDirStrict and fail closed.
  }
}
