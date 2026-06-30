import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeRemote,
  loadSyncConfig,
  getSyncConfigPath,
  assertRemoteNotProjectOrigin,
  pushMemory,
  pullMemory,
  initSyncConfig,
  tryAutoPull,
  tryAutoPush,
  maybeSyncNudge,
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

  it("rejects a git-option-injecting remote/branch (leading '-', ext::/fd:: helpers)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cfg-"));
    const prev = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    const write = (toml: string) => writeFileSync(getSyncConfigPath(), toml);
    try {
      // a "remote" git would parse as an option → arbitrary command execution
      write('[memory.sync]\nremote = "--upload-pack=touch /tmp/pwned"\n');
      assert.throws(() => loadSyncConfig(), /must not start with '-'/);
      // ext:: / fd:: remote helpers run commands by design
      write('[memory.sync]\nremote = "ext::sh -c id"\n');
      assert.throws(() => loadSyncConfig(), /ext::\/fd:: remote helpers/);
      // a branch starting with '-' is likewise rejected
      write('[memory.sync]\nremote = "git@h:me/mem.git"\nbranch = "--output=/tmp/x"\n');
      assert.throws(() => loadSyncConfig(), /must not start with '-'/);
      // a normal config still loads
      write('[memory.sync]\nremote = "git@h:me/mem.git"\nbranch = "main"\n');
      assert.equal(loadSyncConfig()?.remote, "git@h:me/mem.git");
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

  it("does NOT leak KIT_MEMORY_PASSPHRASE into the transport command's environment", () => {
    const store = mkdtempSync(join(tmpdir(), "kit-envstore-"));
    const envDump = join(store, "child-env.txt");
    const machine = mkdtempSync(join(tmpdir(), "kit-envM-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-envproj-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    const prevPass = process.env.KIT_MEMORY_PASSPHRASE;
    // the push command records its own environment, exactly as a logging/`set -x`
    // transport would incidentally expose it
    const cfg: SyncConfig = {
      transport: "command",
      file: "memory.enc",
      pushCmd: `env > "${envDump}"`,
      pullCmd: "true",
    };
    try {
      process.env.KIT_MEMORY_DIR = machine;
      process.env.KIT_MEMORY_PASSPHRASE = PASS; // present in the parent env
      const dbA = openMemoryDb();
      upsertSession(dbA, { sessionId: "s-env", harness: "claude-code", project: "p" });
      dbA.close();

      pushMemory(cfg, PASS, proj);
      const childEnv = readFileSync(envDump, "utf8");
      assert.ok(!childEnv.includes("KIT_MEMORY_PASSPHRASE"), "passphrase must be stripped");
      assert.ok(!childEnv.includes(PASS), "passphrase value must not appear in any var");
      assert.ok(childEnv.includes("KIT_MEMORY_BLOB="), "blob path is still provided");
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      if (prevPass === undefined) delete process.env.KIT_MEMORY_PASSPHRASE;
      else process.env.KIT_MEMORY_PASSPHRASE = prevPass;
      for (const d of [store, machine, proj]) rmSync(d, { recursive: true, force: true });
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

describe("remote-sync — init + auto-sync wiring + nudge", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-init-"));
    const prev = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    try {
      fn(dir);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("initSyncConfig writes a template, won't clobber without force, round-trips --auto flags", () => {
    withDir(() => {
      const a = initSyncConfig({ remote: "git@h:me/m.git", auto: true });
      assert.equal(a.created, true);
      const cfg = loadSyncConfig();
      assert.equal(cfg?.transport, "git");
      assert.equal(cfg?.remote, "git@h:me/m.git");
      assert.equal(cfg?.pullOnStart, true);
      assert.equal(cfg?.pushOnEnd, true);
      // no clobber without force
      assert.equal(initSyncConfig({ remote: "other" }).created, false);
      // force overwrites — and to a command transport
      assert.equal(
        initSyncConfig({ transport: "command", pushCmd: "true", pullCmd: "true", force: true })
          .created,
        true,
      );
      assert.equal(loadSyncConfig()?.transport, "command");
    });
  });

  it("tryAutoPull / tryAutoPush are no-ops without the opt-in flags (and never throw)", () => {
    withDir(() => {
      assert.equal(tryAutoPull("/tmp").ran, false); // no config
      assert.equal(tryAutoPush("/tmp").ran, false);
      initSyncConfig({ transport: "command", pushCmd: "true", pullCmd: "true" }); // no --auto
      assert.equal(tryAutoPull("/tmp").ran, false);
      assert.equal(tryAutoPush("/tmp").ran, false);
    });
  });

  it("push_on_end pushes via the command transport (the ephemeral-container path)", () => {
    const store = mkdtempSync(join(tmpdir(), "kit-store2-"));
    const storeBlob = join(store, "memory.enc");
    const machine = mkdtempSync(join(tmpdir(), "kit-em-"));
    const proj = mkdtempSync(join(tmpdir(), "kit-eproj-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    const prevPass = process.env.KIT_MEMORY_PASSPHRASE;
    try {
      process.env.KIT_MEMORY_DIR = machine;
      process.env.KIT_MEMORY_PASSPHRASE = PASS;
      const dbA = openMemoryDb();
      upsertSession(dbA, { sessionId: "s-auto", harness: "claude-code" });
      insertMessage(dbA, { uuid: "u-auto", sessionId: "s-auto", type: "message", content: "x" });
      dbA.close();
      initSyncConfig({
        transport: "command",
        pushCmd: `cp "$KIT_MEMORY_BLOB" "${storeBlob}"`,
        pullCmd: `cp "${storeBlob}" "$KIT_MEMORY_BLOB"`,
        auto: true,
        force: true,
      });
      const r = tryAutoPush(proj);
      assert.equal(r.ran, true);
      assert.ok(existsSync(storeBlob), "blob deposited by push_on_end");
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      if (prevPass === undefined) delete process.env.KIT_MEMORY_PASSPHRASE;
      else process.env.KIT_MEMORY_PASSPHRASE = prevPass;
      for (const d of [store, machine, proj]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("maybeSyncNudge: null when configured / no store; shows once then suppressed", () => {
    withDir((dir) => {
      // no store → no nudge
      assert.equal(maybeSyncNudge(), null);
      // a non-trivial store (a >64 KB file at the db path; nudge only stats size)
      writeFileSync(join(dir, "memory.db"), Buffer.alloc(70 * 1024));
      const first = maybeSyncNudge();
      assert.match(first ?? "", /kit memory sync init/);
      assert.equal(maybeSyncNudge(), null, "suppressed after the first show (marker)");
    });
    // and null when sync IS already configured
    withDir((dir) => {
      writeFileSync(join(dir, "memory.db"), Buffer.alloc(70 * 1024));
      initSyncConfig({ remote: "git@h:me/m.git" });
      assert.equal(maybeSyncNudge(), null);
    });
  });
});
