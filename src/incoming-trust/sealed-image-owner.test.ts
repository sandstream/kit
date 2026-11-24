import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
  ejectFixtureImages,
  fixtureImageIsAttaching,
  hasNativeImageTool,
} from "./native-image.test-support.js";
import { ejectReadOnlyImage, mountReadOnlyImage } from "./sealed-image-macos.js";
import { withSealedCandidate } from "./sealed-candidate.js";
import { snapshotFixture } from "./snapshot.test-support.js";

const holdImage = [
  'import { writeFileSync } from "node:fs";',
  "const { withSealedCandidate } = await import(process.argv[1]);",
  "withSealedCandidate(process.argv[2], (mount) => {",
  '  writeFileSync(1, JSON.stringify(mount) + "\\n");',
  "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);",
  "});",
].join("\n");

function startFixtureKit(scratch: string, source: string) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      holdImage,
      new URL("./sealed-candidate.js", import.meta.url).href,
      source,
    ],
    { env: { PATH: "/usr/bin:/bin", TMPDIR: scratch }, stdio: ["ignore", "pipe", "inherit"] },
  );
}

it(
  "cleans the owned image after Kit dies and leaves an unrelated mount alone",
  { skip: !hasNativeImageTool, timeout: 120_000 },
  async (t) => {
    const f = snapshotFixture();
    const root = realpathSync(f.root);
    const scratch = join(root, "kit-temp");
    const unrelated = join(root, "other-mounted");
    const otherImage = join(root, "other.dmg");
    const original = lstatSync(root).dev;
    mkdirSync(scratch, { mode: 0o700 });
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(f.source, "data"), "synthetic image contents");
    let child: ReturnType<typeof spawn> | undefined;
    let owned: string | undefined;
    try {
      mountReadOnlyImage(otherImage, f.source, unrelated, root);
      const other = lstatSync(unrelated).dev;
      assert.notEqual(other, original);
      child = startFixtureKit(scratch, f.source);
      const stopped = once(child, "exit");
      const output = createInterface({ input: child.stdout! });
      const response = Promise.race([
        once(output, "line", { signal: t.signal }).then(([line]) => JSON.parse(line) as string),
        stopped.then(([code, signal]) =>
          assert.fail("Kit stopped before mount: " + code + "/" + signal),
        ),
      ]);
      const mount = await response;
      assert.equal(typeof mount, "string");
      assert.ok(mount.startsWith(scratch + "/kit-incoming-sealed-"));
      assert.equal(dirname(dirname(mount)), scratch);
      owned = dirname(mount);
      assert.notEqual(lstatSync(mount).dev, original);
      assert.ok(child.kill("SIGKILL"));
      assert.deepEqual(await stopped, [null, "SIGKILL"]);
      const limit = AbortSignal.timeout(10_000);
      while (existsSync(owned)) await pause(50, undefined, { signal: limit });
      assert.equal(lstatSync(unrelated).dev, other);
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit");
          child.kill("SIGKILL");
          await stopped;
        }
      } finally {
        try {
          await ejectFixtureImages(scratch);
        } finally {
          if (existsSync(otherImage)) ejectReadOnlyImage(otherImage, root);
        }
        f.cleanup();
      }
    }
  },
);

it(
  "finishes attachment recovery when Kit dies during the native operation",
  { skip: !hasNativeImageTool, timeout: 120_000 },
  async (t) => {
    const f = snapshotFixture();
    const scratch = join(realpathSync(f.root), "kit-temp");
    mkdirSync(scratch, { mode: 0o700 });
    writeFileSync(join(f.source, "data"), "synthetic image contents");
    const child = startFixtureKit(scratch, f.source);
    const stopped = once(child, "exit");
    try {
      for (;;) {
        const name = readdirSync(scratch).find((item) => item.startsWith("kit-incoming-sealed-"));
        if (name && fixtureImageIsAttaching(join(scratch, name))) break;
        assert.equal(child.exitCode, null, "Kit stopped before attachment");
        await pause(10, undefined, { signal: t.signal });
      }
      assert.ok(child.kill("SIGKILL"));
      assert.deepEqual(await stopped, [null, "SIGKILL"]);
      const limit = AbortSignal.timeout(15_000);
      while (readdirSync(scratch).length > 0) await pause(50, undefined, { signal: limit });
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await stopped;
        }
      } finally {
        await ejectFixtureImages(scratch);
        f.cleanup();
      }
    }
  },
);

it(
  "refuses to use an image when the host owner cannot start",
  { skip: !hasNativeImageTool },
  () => {
    const f = snapshotFixture();
    const prior = process.env.TMPDIR;
    process.env.TMPDIR = f.root;
    try {
      const result = withSealedCandidate(f.source, () => assert.fail("Mounted without an owner"), {
        executable: join(f.root, "missing-node"),
        assertStableBuild: () => {},
      });
      assert.deepEqual(result, { verified: false, reason: "sealed-input-unavailable" });
      assert.deepEqual(readdirSync(f.root), ["source"]);
    } finally {
      if (prior === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prior;
      f.cleanup();
    }
  },
);
