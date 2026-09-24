import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fixture, closedSource, modes } from "./backup.test-support.js";
import { generateMemoryKeypair, restoreEncrypted, restoreWithKey } from "./backup.js";

for (const mode of modes) {
  it(`${mode.name} export and restore create missing destination directories`, (t) => {
    const { dir, src, track } = fixture(t);
    closedSource(src);
    const blob = join(dir, "new-export", "nested", "memory.enc");
    const dest = join(dir, "new-device", "store", "memory.db");
    assert.equal(existsSync(join(dir, "new-export")), false);
    assert.equal(existsSync(join(dir, "new-device")), false);
    mode.backup(src, blob);
    mode.restore(blob, dest);
    const restored = track(new DatabaseSync(dest, { readOnly: true }));
    assert.equal(
      restored.prepare("SELECT content FROM original WHERE id = 7").get()?.content,
      "preserved",
    );
    assert.equal(restored.prepare("PRAGMA user_version").get()?.user_version, 19);
  });

  it(`${mode.name} failed decryption creates no destination directories`, (t) => {
    const { dir, src, blob } = fixture(t);
    closedSource(src);
    mode.backup(src, blob);
    const dest = join(dir, "new-device", "nested", "memory.db");
    assert.throws(() => {
      if (mode.name === "passphrase") restoreEncrypted("unrelated credential", blob, dest);
      else restoreWithKey(generateMemoryKeypair().privateJwk, blob, dest);
    }, /unable to authenticate|unsupported state/i);
    assert.equal(existsSync(join(dir, "new-device")), false);
  });

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    it(`${mode.name} never creates an export directory on a reserved ${suffix} path`, (t) => {
      const { src } = fixture(t);
      closedSource(src);
      const reserved = src + suffix;
      assert.equal(existsSync(reserved), false);
      assert.throws(
        () => mode.backup(src, join(reserved, "nested", "memory.enc")),
        /different|alias/i,
      );
      assert.equal(existsSync(reserved), false);
      const writer = new DatabaseSync(src);
      try {
        writer.exec(`PRAGMA journal_mode = ${suffix === "-journal" ? "DELETE" : "WAL"};
          UPDATE original SET content = 'still writable'`);
        assert.equal(
          writer.prepare("SELECT content FROM original").get()?.content,
          "still writable",
        );
      } finally {
        writer.close();
      }
    });
  }

  it(
    `${mode.name} missing parents under a linked ancestor are private without changing existing permissions`,
    {
      skip:
        process.platform === "win32" &&
        "This assertion requires POSIX modes and unprivileged symlinks",
    },
    (t) => {
      const { dir, src, blob, track } = fixture(t);
      closedSource(src);
      mode.backup(src, blob);
      const parent = join(dir, "existing");
      mkdirSync(parent, { mode: 0o755 });
      const previousMode = statSync(parent).mode;
      const link = join(dir, "linked");
      symlinkSync(parent, link, "dir");
      const dest = join(link, "new-device", "store", "memory.db");
      mode.restore(blob, dest);
      assert.equal(statSync(parent).mode, previousMode);
      for (const path of [join(parent, "new-device"), join(parent, "new-device", "store")])
        assert.equal(statSync(path).mode & 0o077, 0);
      assert.equal(statSync(dest).mode & 0o777, 0o600);
      const restored = track(new DatabaseSync(dest, { readOnly: true }));
      assert.equal(restored.prepare("SELECT content FROM original").get()?.content, "preserved");
    },
  );
}
