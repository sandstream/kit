import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { ejectReadOnlyImage } from "./sealed-image-macos.js";
import { imageOwnerPaths, readImageMessage } from "./sealed-image-owner.js";

/** A supported OS can still have an older diskutil, or no image tool in the test environment. */
export const hasNativeImageTool =
  process.platform === "darwin" &&
  spawnSync("/usr/sbin/diskutil", ["image", "create", "from", "--help"], {
    encoding: "utf8",
    timeout: 2000,
  }).stdout?.includes("diskutil image create from") === true;

export function fixtureImageOwnerPid(work: string): number | undefined {
  const pid = readImageMessage(imageOwnerPaths(work).ownerPid);
  return pid && /^[1-9]\d*$/.test(pid) ? Number(pid) : undefined;
}

function ownerIsRunning(work: string): boolean {
  const pid = fixtureImageOwnerPid(work);
  if (!pid) return false;
  const result = spawnSync("/bin/ps", ["-o", "state=,args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.error) throw result.error;
  const line = result.stdout.trim();
  return (
    !line.startsWith("Z") && line.includes("sealed-image-owner-worker.js") && line.includes(work)
  );
}

export function fixtureImageIsAttaching(work: string): boolean {
  const owner = fixtureImageOwnerPid(work);
  if (!owner) return false;
  const rows = execFileSync("/bin/ps", ["-ax", "-o", "ppid=,args="], { encoding: "utf8" });
  return rows.split("\n").some((row) => {
    const fields = row.trim().split(/\s+/, 5);
    return (
      Number(fields[0]) === owner &&
      fields[1] === "/usr/sbin/diskutil" &&
      fields[2] === "image" &&
      fields[3] === "attach" &&
      row.endsWith(imageOwnerPaths(work).image)
    );
  });
}

async function rescueFixtureImage(work: string): Promise<void> {
  const limit = AbortSignal.timeout(25_000);
  while (ownerIsRunning(work)) await pause(50, undefined, { signal: limit });
  const { image } = imageOwnerPaths(work);
  if (existsSync(image)) ejectReadOnlyImage(image, work);
}

/** Rescue only images created under this test's own private temporary root. */
export async function ejectFixtureImages(scratch: string): Promise<void> {
  const workspaces = readdirSync(scratch)
    .filter((name) => /^kit-incoming-sealed-[a-zA-Z0-9]+$/.test(name))
    .map((name) => join(scratch, name));
  const results = await Promise.allSettled(workspaces.map(rescueFixtureImage));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Could not eject test images");
}
