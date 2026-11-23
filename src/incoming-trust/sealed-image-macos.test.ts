import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { hasNativeImageTool } from "./native-image.test-support.js";
import {
  checkReadOnlyImage,
  ejectReadOnlyImage,
  mountReadOnlyImage,
} from "./sealed-image-macos.js";
import { snapshotFixture } from "./snapshot.test-support.js";

function observeDiskImageCreation(t: TestContext, create: (args: readonly string[]) => void): void {
  const native = childProcess.execFileSync;
  const mock = t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof native>) => {
    const [file, flags] = args;
    if (file === "/usr/sbin/diskutil" && flags?.slice(0, 3).join(" ") === "image create from")
      create(flags);
    return native(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

function creationError(message: string): Error {
  return Object.assign(new Error("image creation failed"), {
    status: 1,
    stderr: Buffer.from(message),
  });
}

const dissent =
  "The operation could not be completed. (com.apple.DiskImages2.ErrorDomain error 156.)";

it(
  "mounts the owned image with read-only media and ejects it",
  { skip: !hasNativeImageTool },
  () => {
    const f = snapshotFixture();
    const work = realpathSync(f.root);
    const source = join(work, "source", "data.txt");
    const image = join(work, "test.dmg");
    const mount = join(work, "captured");
    try {
      mkdirSync(mount, { mode: 0o700 });
      const original = lstatSync(mount).dev;
      writeFileSync(source, "approved");
      const device = mountReadOnlyImage(image, join(work, "source"), mount, work);
      checkReadOnlyImage(mount, device, work);
      assert.notEqual(lstatSync(mount).dev, original);
      writeFileSync(source, "changed");
      const saved = join(mount, "data.txt");
      assert.equal(readFileSync(saved, "utf8"), "approved");
      assert.throws(() => writeFileSync(saved, "replace"), { code: "EROFS" });
    } finally {
      try {
        ejectReadOnlyImage(image, work);
        const unmounted = lstatSync(mount, { throwIfNoEntry: false });
        assert.ok(!unmounted || unmounted.dev === lstatSync(f.root).dev);
      } finally {
        f.cleanup();
      }
    }
  },
);

it(
  "retries a busy image creation and still mounts the expected read-only bytes",
  { skip: !hasNativeImageTool },
  (t) => {
    const f = snapshotFixture();
    const work = realpathSync(f.root);
    const image = join(work, "test.dmg");
    const mount = join(work, "captured");
    let attempts = 0;
    observeDiskImageCreation(t, () => {
      if (++attempts === 1) throw creationError(dissent);
    });
    try {
      mkdirSync(mount, { mode: 0o700 });
      writeFileSync(join(f.source, "data.txt"), "approved");
      const device = mountReadOnlyImage(image, f.source, mount, work);
      assert.equal(attempts, 2);
      checkReadOnlyImage(mount, device, work);
      const saved = join(mount, "data.txt");
      assert.equal(readFileSync(saved, "utf8"), "approved");
      assert.throws(() => writeFileSync(saved, "replace"), { code: "EROFS" });
    } finally {
      try {
        ejectReadOnlyImage(image, work);
      } finally {
        f.cleanup();
      }
    }
  },
);

for (const [name, message, output, count] of [
  ["persistent dissent", dissent, undefined, 3],
  ["unrelated native error", "com.apple.DiskImages2.ErrorDomain error 157", undefined, 1],
  ["dissent with an output file", dissent, "partial", 1],
] as const) {
  it(`refuses image creation after ${name}`, (t) => {
    const f = snapshotFixture();
    const work = realpathSync(f.root);
    const image = join(work, "test.dmg");
    const error = creationError(message);
    let attempts = 0;
    observeDiskImageCreation(t, () => {
      attempts++;
      if (output !== undefined) writeFileSync(image, output);
      throw error;
    });
    try {
      assert.throws(() => mountReadOnlyImage(image, f.source, join(work, "captured"), work), error);
      assert.equal(attempts, count);
      if (output !== undefined) assert.equal(readFileSync(image, "utf8"), output);
    } finally {
      f.cleanup();
    }
  });
}
