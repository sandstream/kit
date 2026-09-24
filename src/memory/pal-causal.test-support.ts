import type { TestContext } from "node:test";
import { fixture } from "./backup.test-support.js";
import { openMemoryDb } from "./db.js";
import { palAdd } from "./pal.js";
import { mergeDb } from "./merge.js";

export function replicas(t: TestContext) {
  const files = fixture(t);
  const previous = process.env.KIT_DEVICE_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const device = (name: "a" | "b" | "c") => {
    process.env.KIT_DEVICE_ID = `causal-device-${name}`;
  };
  device("a");
  const a = files.track(openMemoryDb(files.src));
  const id = palAdd(a, { title: "Check sandbox receipt" });
  device("b");
  const b = files.track(openMemoryDb(files.dest));
  mergeDb(b, files.src);
  return { ...files, a, b, id, device };
}
