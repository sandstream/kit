import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameIdentity } from "../utils/same-file.js";
import { privateDirIsControlled } from "../utils/secure-perms.js";
import { readSnapshotBytes } from "./snapshot-io.js";

// The macOS shell owns this directory before it contains any Node bytes.
// Only a staging executable and protocol markers may be removed here.
const stageScript = `
set -eu
root=$KIT_RUNTIME_STAGE_ROOT
umask 077
/bin/mkdir -m 700 "$root"
cd "$root"
identity=$(/usr/bin/stat -f '%d:%i' .)
owns_path() {
  [ ! -L "$root" ] &&
    [ "$(/usr/bin/stat -f '%d:%i' "$root" 2>/dev/null)" = "$identity" ]
}
cleanup() {
  /bin/rm -f ./node ./ready.tmp ./ready
  if owns_path; then /bin/rmdir "$root"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s\\n' "$$:$identity" > ./ready.tmp
/bin/mv ./ready.tmp ./ready
# The parent holds the only write end. A process exit closes it.
IFS= read -r unused || :
`;

function waitForStage(check: () => boolean): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Node staging owner did not respond");
    Atomics.wait(wait, 0, 0, 25);
  }
}

export function startRuntimeStage() {
  const root = join(
    realpathSync(tmpdir()),
    "kit-incoming-runtime-" + randomBytes(16).toString("hex"),
  );
  const marker = join(root, "ready");
  // The shell receives a fixed script. The staging path is a quoted data value.
  const child = spawn("/bin/sh", ["-c", stageScript], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", KIT_RUNTIME_STAGE_ROOT: root },
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start Node staging owner");
  const current = () => lstatSync(root, { bigint: true, throwIfNoEntry: false });
  try {
    waitForStage(() => {
      const file = lstatSync(marker, { throwIfNoEntry: false });
      return Boolean(file?.isFile() && file.size > 0);
    });
    const identity = current();
    const markerBytes = readSnapshotBytes(marker, lstatSync(marker, { bigint: true }), 128);
    if (
      !identity?.isDirectory() ||
      !privateDirIsControlled(root) ||
      markerBytes.toString("utf8") !== `${pid}:${identity.dev}:${identity.ino}\n`
    )
      throw new Error("Node staging owner identity changed");
    const assertCurrent = () => {
      if (!sameIdentity(identity, current())) throw new Error("Node staging directory changed");
    };
    return {
      executable: join(root, "node"),
      assertCurrent,
      release: () => {
        child.stdin.destroy();
        waitForStage(() => !sameIdentity(identity, current()));
        if (current()) throw new Error("Node staging directory changed");
      },
    };
  } catch (error) {
    child.stdin.destroy();
    throw error;
  }
}
