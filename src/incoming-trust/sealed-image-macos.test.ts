import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { hasNativeImageTool } from "./native-image.test-support.js";
import {
  checkReadOnlyImage,
  ejectReadOnlyImage,
  mountReadOnlyImage,
} from "./sealed-image-macos.js";
import { snapshotFixture } from "./snapshot.test-support.js";

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
