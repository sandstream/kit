import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb } from "./db.js";
import { palAdd, palList, palPrune, palSyncFindings, volumeMissing } from "./pal.js";
import { syncSecurityFindings } from "../findings-track.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

// A scanner finding describes one folder at one moment. When the folder is deleted (a scratch
// directory, a removed worktree) nothing can fix or re-scan it, so it closes. A bug report or a
// plan says something about the code, which outlives the folder it was typed in, so it stays.

const previousDevice = process.env.KIT_DEVICE_ID;
const previousDb = process.env.KIT_MEMORY_DB;
const startDir = process.cwd();
before(() => {
  process.env.KIT_DEVICE_ID = "prune-test-device";
});
after(() => {
  process.chdir(startDir);
  if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
  else process.env.KIT_DEVICE_ID = previousDevice;
  if (previousDb === undefined) delete process.env.KIT_MEMORY_DB;
  else process.env.KIT_MEMORY_DB = previousDb;
});

const FINDING = { dedupKey: "dependency:osv-scanner", title: "osv-scanner: fail" };

/** Run `fn` with the working directory set to `dir`, restoring it after. */
function inDir<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

function withDevice<T>(id: string, fn: () => T): T {
  const before = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = id;
  try {
    return fn();
  } finally {
    process.env.KIT_DEVICE_ID = before;
  }
}

function openIds(db: ReturnType<typeof openMemoryDb>): string[] {
  return palList(db, { allDevices: true })
    .map((p) => p.id)
    .sort();
}

describe("palPrune closes findings of a removed folder, and only findings", () => {
  const setup = (t: { after(fn: () => void): void }) => {
    const db = openMemoryDb(":memory:");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-pal-prune-kind-")));
    t.after(() => rmTemp(root));
    return { db, root };
  };

  it("closes a finding whose folder is gone and keeps one whose folder is live", (t) => {
    const { db, root } = setup(t);
    const live = join(root, "live");
    const dead = join(root, "dead");
    mkdirSync(live);
    mkdirSync(dead);
    inDir(dead, () => palSyncFindings(db, "sec", [FINDING], { scope: dead }));
    inDir(live, () => palSyncFindings(db, "sec", [FINDING], { scope: live }));
    rmSync(dead, { recursive: true });
    const r = palPrune(db);
    assert.equal(r.closed.length, 1);
    assert.equal(openIds(db).length, 1);
    assert.deepEqual(r.kept, []);
  });

  it("keeps a bug report or plan whose folder is gone, and says so", (t) => {
    const { db, root } = setup(t);
    const dead = join(root, "dead");
    mkdirSync(dead);
    const id = inDir(dead, () =>
      palAdd(db, { title: "concurrent audit appends duplicate hashes" }),
    );
    rmSync(dead, { recursive: true });
    const r = palPrune(db);
    assert.deepEqual(r.closed, []);
    assert.deepEqual(r.kept, [id]);
    assert.deepEqual(openIds(db), [id]);
  });

  it("closes a finding when the whole tree above it is gone, as a deleted scratch directory is", (t) => {
    const { db, root } = setup(t);
    const tree = join(root, "scratch");
    const project = join(tree, "deep", "project");
    mkdirSync(project, { recursive: true });
    inDir(project, () => palSyncFindings(db, "sec", [FINDING], { scope: project }));
    rmSync(tree, { recursive: true });
    assert.equal(palPrune(db).closed.length, 1);
    assert.deepEqual(openIds(db), []);
  });

  it("does not touch another device's finding", (t) => {
    const { db, root } = setup(t);
    const dead = join(root, "dead");
    mkdirSync(dead);
    withDevice("other-device", () =>
      inDir(dead, () => palSyncFindings(db, "sec", [FINDING], { scope: dead })),
    );
    rmSync(dead, { recursive: true });
    assert.deepEqual(palPrune(db).closed, []);
    assert.equal(openIds(db).length, 1);
  });
});

describe("kit check prunes findings of removed folders by itself", () => {
  it("closes a dead folder's finding during the next sync from a live folder", async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-pal-prune-sync-")));
    t.after(() => rmTemp(root));
    process.env.KIT_MEMORY_DB = join(root, "memory.db");
    const dead = join(root, "dead");
    const live = join(root, "live");
    mkdirSync(dead);
    mkdirSync(live);
    const db = openMemoryDb(process.env.KIT_MEMORY_DB);
    inDir(dead, () => palSyncFindings(db, "sec", [FINDING], { scope: dead }));
    assert.equal(openIds(db).length, 1);
    db.close();
    rmSync(dead, { recursive: true });

    process.chdir(live);
    await syncSecurityFindings([]);
    process.chdir(startDir);

    const after = openMemoryDb(process.env.KIT_MEMORY_DB);
    try {
      assert.deepEqual(openIds(after), []);
    } finally {
      after.close();
    }
  });
});

describe("volumeMissing tells an unmounted volume from a deleted folder", () => {
  it("is false for a folder on a volume that is there", () => {
    assert.equal(volumeMissing(join(tmpdir(), "kit-no-such-folder", "deep")), false);
  });

  it(
    "is true for a path under a mount point that is not mounted",
    {
      skip: process.platform === "win32" && "mount points are POSIX; Windows checks the drive root",
    },
    () => {
      assert.equal(volumeMissing("/Volumes/kit-test-no-such-volume/project"), true);
      assert.equal(volumeMissing("/mnt/kit-test-no-such-mount/project"), true);
      assert.equal(volumeMissing("/media/kit-test-no-such-disk/project"), true);
    },
  );
});
