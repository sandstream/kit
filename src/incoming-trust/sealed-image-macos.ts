import { execFileSync } from "node:child_process";

const DISKUTIL = "/usr/sbin/diskutil";
const HDIUTIL = "/usr/bin/hdiutil";
const PLUTIL = "/usr/bin/plutil";

function run(tool: string, args: string[], cwd: string, input?: Buffer): Buffer {
  return execFileSync(tool, args, {
    cwd,
    input,
    env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

function plist(bytes: Buffer, cwd: string): Record<string, unknown> {
  const json = run(PLUTIL, ["-convert", "json", "-o", "-", "-"], cwd, bytes);
  const value: unknown = JSON.parse(json.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid disk image metadata");
  return value as Record<string, unknown>;
}

function entities(value: Record<string, unknown>): Record<string, unknown>[] {
  const rows = value["system-entities"];
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object"))
    throw new Error("Invalid disk image entities");
  return rows;
}

function apfsVolume(rows: Record<string, unknown>[]): string {
  const volumes = rows.filter((row) => row["filesystem-type"] === "apfs");
  const id = volumes[0]?.["dev-entry"];
  if (volumes.length !== 1 || typeof id !== "string" || !/^disk\d+s\d+$/.test(id))
    throw new Error("Unexpected APFS volume");
  return id;
}

export function mountReadOnlyImage(
  image: string,
  source: string,
  mount: string,
  cwd: string,
): string {
  run(DISKUTIL, ["image", "create", "from", "--format", "UDRO", source, image], cwd);
  const attached = run(
    DISKUTIL,
    ["image", "attach", "--plist", "--readOnly", "--noMount", image],
    cwd,
  );
  const volume = apfsVolume(entities(plist(attached, cwd)));
  run(
    DISKUTIL,
    [
      "mount",
      "readOnly",
      "nobrowse",
      "-mountOptions",
      "noexec,nosuid,nodev",
      "-mountPoint",
      mount,
      volume,
    ],
    cwd,
  );
  return volume;
}

export function checkReadOnlyImage(mount: string, volume: string, cwd: string): void {
  const info = plist(run(DISKUTIL, ["info", "-plist", mount], cwd), cwd);
  if (
    info.MountPoint !== mount ||
    info.DeviceIdentifier !== volume ||
    info.Writable !== false ||
    info.WritableMedia !== false ||
    info.WritableVolume !== false
  )
    throw new Error("Disk image is not mounted read-only");
}

function findImageDevice(image: string, cwd: string): string | undefined {
  const { images } = plist(run(HDIUTIL, ["info", "-plist"], cwd), cwd);
  if (!Array.isArray(images)) throw new Error("Invalid attached image list");
  const matches = images.filter((row) => row && row["image-path"] === image);
  if (matches.length === 0) return undefined;
  const rows = entities(matches[0]);
  const whole = rows.find((row) => row["content-hint"] === "GUID_partition_scheme");
  const device = whole?.["dev-entry"];
  if (matches.length !== 1 || typeof device !== "string" || !/^\/dev\/disk\d+$/.test(device))
    throw new Error("Ambiguous attached image device");
  return device;
}

/** Resolve the owned image before ejecting. Device identifiers can be reused after a detach. */
export function ejectReadOnlyImage(image: string, cwd: string): void {
  const device = findImageDevice(image, cwd);
  if (device === undefined) return;
  run(DISKUTIL, ["eject", device], cwd);
  if (findImageDevice(image, cwd) !== undefined) throw new Error("Disk image is still attached");
}
