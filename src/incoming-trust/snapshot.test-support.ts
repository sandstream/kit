import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { secureDirStrict } from "../utils/secure-perms.js";

export function snapshotFixture() {
  const root = mkdtempSync(join(tmpdir(), "kit-incoming-snapshot-"));
  try {
    secureDirStrict(root);
    const source = join(root, "source");
    mkdirSync(source);
    return { root, source, destination: join(root, "captured"), cleanup: () => rmTemp(root) };
  } catch (error) {
    rmTemp(root);
    throw error;
  }
}
