import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeRemote,
  loadSyncConfig,
  getSyncConfigPath,
  assertRemoteNotProjectOrigin,
  pushMemory,
  pullMemory,
  type SyncConfig,
} from "./remote-sync.js";
import { openMemoryDb, searchMessages, upsertSession, insertMessage } from "./db.js";

// A strong passphrase (≥12 chars, no weak markers) so validatePassphrase accepts it.
const PASS = "Zephyr-Quokka-Lantern-9931";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

describe("remote-sync — normalizeRemote", () => {
  it("folds ssh/scp and https forms of the same repo to one value", () => {
    const https = normalizeRemote("https://github.com/me/mem.git");
    assert.equal(normalizeRemote("git@github.com:me/mem.git"), https);
    assert.equal(normalizeRemote("https://github.com/me/mem/"), https);
    assert.equal(normalizeRemote("HTTPS://GitHub.com/me/mem"), https);
  });
  it("keeps distinct repos distinct", () => {
    assert.notEqual(
      normalizeRemote("git@github.com:me/mem.git"),
      normalizeRemote("git@github.com:me/project.git"),
    );
  });
});

describe("remote-sync — loadSyncConfig (LOCAL, ~/.kit only)", () => {
  it("returns null when no sync.toml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cfg-"));
    const prev = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    try {
      assert.equal(loadSyncConfig(), null);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses [memory.sync] and applies defaults; rejects a path-traversal file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cfg-"));
    const prev = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    try {
      writeFileSync(getSyncConfigPath(), '[memory.sync]\nremote = "git@h:me/mem.git"\n');
      const cfg = loadSyncConfig();
      assert.equal(cfg?.remote, "git@h:me/mem.git");
      assert.equal(cfg?.branch, "main");
      assert.equal(cfg?.file, "memory.enc");

      writeFileSync(
        getSyncConfigPath(),
        '[memory.sync]\nremote = "git@h:me/mem.git"\nfile = "../escape"\n',
      );
      assert.throws(() => loadSyncConfig(), /bare filename/);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("remote-sync — assertRemoteNotProjectOrigin (anti-exfil guard)", () => {
  it("throws when the sync remote IS the project's origin", () => {
    const proj = mkdtempSync(join(tmpdir(), "kit-proj-"));
    try {
      git(["init", "-q"], proj);
      git(["remote", "add", "origin", "git@github.com:me/project.git"], proj);
      // same repo, different URL form → still refused
      assert.throws(
        () => assertRemoteNotProjectOrigin("https://github.com/me/project", proj),
        /never the project repo/,
      );
      // a genuinely separate private repo is allowed
      assert.doesNotThrow(() =>
        assertRemoteNotProjectOrigin("git@github.com:me/private-memory.git", proj),
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("remote-sync — push → pull round trip over a git remote", () => {
  it("encrypts the store to the remote and merges it back on another machine", () => {
    const bare = mkdtempSync(join(tmpdir(), "kit-bare-")) + "/mem.git";
    const machineA = mkdtempSync(join(tmpdir(), "kit-A-"));
    const machineB = mkdtempSync(join(tmpdir(), "kit-B-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-proj-")); // no origin → guard passes
    const prevDir = process.env.KIT_MEMORY_DIR;
    const marker = "gap4-roundtrip-marker-xyz";
    try {
      execFileSync("git", ["init", "--bare", "-q", bare]);
      const cfg: SyncConfig = {
        transport: "git",
        remote: bare,
        branch: "main",
        file: "memory.enc",
      };

      // --- machine A: seed a message, then push ---
      process.env.KIT_MEMORY_DIR = machineA;
      const dbA = openMemoryDb();
      upsertSession(dbA, { sessionId: "s-gap4", harness: "claude-code", project: "p" });
      insertMessage(dbA, {
        uuid: "u-gap4",
        sessionId: "s-gap4",
        type: "message",
        role: "user",
        content: marker,
      });
      dbA.close();

      const pushed = pushMemory(cfg, PASS, proj);
      assert.equal(pushed.pushed, true);

      // the remote now carries an encrypted blob (not plaintext)
      const inspect = mkdtempSync(join(tmpdir(), "kit-inspect-"));
      git(["clone", "-q", "--branch", "main", bare, "."], inspect);
      assert.ok(existsSync(join(inspect, "memory.enc")), "blob present on remote");
      rmSync(inspect, { recursive: true, force: true });

      // --- machine B: empty store, pull, confirm the message arrived ---
      process.env.KIT_MEMORY_DIR = machineB;
      const r = pullMemory(cfg, PASS, proj);
      assert.equal(r.found, true);
      assert.ok((r.merge?.messages ?? 0) >= 1, "at least one message merged");

      const dbB = openMemoryDb();
      const hits = searchMessages(dbB, "roundtrip"); // FTS tokenizes on the hyphens
      dbB.close();
      assert.ok(
        hits.some((h) => (h.content ?? "").includes(marker)),
        "machine B recalls machine A's message after pull",
      );
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      for (const d of [bare.replace(/\/mem\.git$/, ""), machineA, machineB, proj]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("pull reports 'not found' when the remote has no blob yet", () => {
    const bare = mkdtempSync(join(tmpdir(), "kit-bare2-")) + "/mem.git";
    const machine = mkdtempSync(join(tmpdir(), "kit-M-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-proj2-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    try {
      execFileSync("git", ["init", "--bare", "-q", bare]);
      process.env.KIT_MEMORY_DIR = machine;
      const r = pullMemory(
        { transport: "git", remote: bare, branch: "main", file: "memory.enc" },
        PASS,
        proj,
      );
      assert.equal(r.found, false);
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      for (const d of [bare.replace(/\/mem\.git$/, ""), machine, proj]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

describe("remote-sync — command transport (bring-your-own move: S3/rclone/scp/USB)", () => {
  it("loadSyncConfig requires push_cmd + pull_cmd for transport=command", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cmdcfg-"));
    const prev = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    try {
      writeFileSync(getSyncConfigPath(), '[memory.sync]\ntransport = "command"\n');
      assert.throws(() => loadSyncConfig(), /push_cmd and pull_cmd/);
      writeFileSync(
        getSyncConfigPath(),
        '[memory.sync]\ntransport = "command"\npush_cmd = "true"\npull_cmd = "true"\n',
      );
      const cfg = loadSyncConfig();
      assert.equal(cfg?.transport, "command");
      assert.equal(cfg?.pushCmd, "true");
      assert.equal(cfg?.pullCmd, "true");
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("push runs push_cmd over the blob; pull runs pull_cmd then merges (round trip via a plain file)", () => {
    const store = mkdtempSync(join(tmpdir(), "kit-store-"));
    const storeBlob = join(store, "memory.enc"); // stands in for S3/scp target
    const machineA = mkdtempSync(join(tmpdir(), "kit-cA-"));
    const machineB = mkdtempSync(join(tmpdir(), "kit-cB-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-cproj-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    const marker = "cmd-transport-marker-zzz";
    // The "transport" is just `cp` to/from a fixed path — the same shape as
    // `aws s3 cp`, `rclone copyto`, or `scp`, driven by $KIT_MEMORY_BLOB.
    const cfg: SyncConfig = {
      transport: "command",
      file: "memory.enc",
      pushCmd: `cp "$KIT_MEMORY_BLOB" "${storeBlob}"`,
      pullCmd: `cp "${storeBlob}" "$KIT_MEMORY_BLOB"`,
    };
    try {
      process.env.KIT_MEMORY_DIR = machineA;
      const dbA = openMemoryDb();
      upsertSession(dbA, { sessionId: "s-cmd", harness: "claude-code", project: "p" });
      insertMessage(dbA, {
        uuid: "u-cmd",
        sessionId: "s-cmd",
        type: "message",
        role: "user",
        content: marker,
      });
      dbA.close();

      const pushed = pushMemory(cfg, PASS, proj);
      assert.equal(pushed.pushed, true);
      assert.ok(existsSync(storeBlob), "push_cmd deposited the encrypted blob in the store");

      process.env.KIT_MEMORY_DIR = machineB;
      const r = pullMemory(cfg, PASS, proj);
      assert.equal(r.found, true);
      const dbB = openMemoryDb();
      const hits = searchMessages(dbB, "marker");
      dbB.close();
      assert.ok(hits.some((h) => (h.content ?? "").includes(marker)));
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      for (const d of [store, machineA, machineB, proj]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("pull reports 'not found' when the pull_cmd produces no blob", () => {
    const machine = mkdtempSync(join(tmpdir(), "kit-cM-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-cproj2-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    try {
      process.env.KIT_MEMORY_DIR = machine;
      const r = pullMemory(
        { transport: "command", file: "memory.enc", pushCmd: "true", pullCmd: "true" },
        PASS,
        proj,
      );
      assert.equal(r.found, false);
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      for (const d of [machine, proj]) rmSync(d, { recursive: true, force: true });
    }
  });
});
