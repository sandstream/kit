import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { it } from "node:test";
import { secureDirStrict } from "../utils/secure-perms.js";
import { IncomingTrustStore } from "./authority-store.js";
import { storeFixture } from "./authority-store.test-support.js";

it("uses the operating-system account home rather than HOME or a project override", () => {
  const before = process.env.HOME;
  try {
    process.env.HOME = "/incoming-controlled-home";
    assert.equal(
      new IncomingTrustStore().directory,
      join(userInfo().homedir, ".kit", "incoming-trust"),
    );
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

for (const kind of ["inside", "contains"] as const) {
  it(`refuses an authority directory that ${kind === "inside" ? "is inside" : "contains"} the repository`, () => {
    const f = storeFixture();
    try {
      // The store checks that the parent of the requested directory is controlled before it compares
      // paths, and a system temp directory often is not (group-writable on Linux, inherited ACL on
      // Windows). Build the layout under the fixture's own controlled root.
      let repository = f.repository;
      let directory = join(f.repository, "state");
      if (kind === "inside") secureDirStrict(f.repository);
      else {
        directory = join(f.root, "outer");
        mkdirSync(directory);
        secureDirStrict(directory);
        repository = join(directory, "repository");
        mkdirSync(repository);
      }
      const store = new IncomingTrustStore(directory);
      assert.throws(
        () => store.update(repository, { type: "enroll", authority: f.proof.authority }),
        /outside the repository/,
      );
      assert.equal(existsSync(join(directory, "authority.sqlite")), false);
    } finally {
      f.cleanup();
    }
  });
}

it("resolves a repository path alias to the existing authority binding", () => {
  const f = storeFixture();
  try {
    const enrolled = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const alias = join(f.root, "repository-alias");
    symlinkSync(f.repository, alias, process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(f.store.read(alias), enrolled);
    const staged = f.store.update(alias, {
      type: "stage",
      expectedGeneration: 1,
      expectedPhase: "pending",
      candidateDigest: "c".repeat(64),
    });
    assert.deepEqual(f.store.read(f.repository), staged);
    assert.throws(
      () => f.store.update(alias, { type: "enroll", authority: f.proof.authority }),
      /already-enrolled/,
    );
  } finally {
    f.cleanup();
  }
});

it("refuses a replaced repository directory and preserves the enrolled database", () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const path = join(f.directory, "authority.sqlite");
    const original = readFileSync(path);
    renameSync(f.repository, join(f.root, "previous-repository"));
    mkdirSync(f.repository);
    assert.throws(() => f.store.read(f.repository), /repository-binding-changed/);
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "state-unavailable",
    });
    assert.deepEqual(readFileSync(path), original);
  } finally {
    f.cleanup();
  }
});

it("refuses a hard-linked authority database without changing either link", () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const path = join(f.directory, "authority.sqlite");
    const copy = join(f.root, "linked-authority");
    linkSync(path, copy);
    const before = readFileSync(copy);
    assert.throws(() => f.store.read(f.repository), /unavailable/);
    assert.throws(
      () =>
        f.store.update(f.repository, {
          type: "reject",
          expectedGeneration: 1,
          expectedPhase: "pending",
        }),
      /unavailable/,
    );
    assert.deepEqual(readFileSync(copy), before);
  } finally {
    f.cleanup();
  }
});

it("refuses corrupt authority without replacing it or granting execution", () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const path = join(f.directory, "authority.sqlite");
    writeFileSync(path, "damaged authority, preserve this evidence");
    assert.throws(() => f.store.read(f.repository));
    assert.throws(() =>
      f.store.update(f.repository, { type: "enroll", authority: f.proof.authority }),
    );
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "state-unavailable",
    });
    assert.equal(readFileSync(path, "utf8"), "damaged authority, preserve this evidence");
  } finally {
    f.cleanup();
  }
});

for (const kind of ["directory", "parent", "file"] as const) {
  it(
    `refuses a linked authority ${kind}`,
    {
      skip:
        process.platform === "win32"
          ? "Creating symbolic links requires Windows developer mode or privilege; native ACL tests are separate."
          : false,
    },
    () => {
      const f = storeFixture();
      try {
        f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
        let store = f.store;
        if (kind === "file") {
          const path = join(f.directory, "authority.sqlite");
          const saved = join(f.root, "saved.sqlite");
          renameSync(path, saved);
          symlinkSync(saved, path);
        } else if (kind === "directory") {
          const alias = join(f.root, "linked-authority");
          symlinkSync(f.directory, alias);
          store = new IncomingTrustStore(alias);
        } else {
          const alias = join(f.root, "linked-parent");
          symlinkSync(f.root, alias);
          store = new IncomingTrustStore(join(alias, "authority"));
        }
        assert.throws(() => store.read(f.repository), /unavailable/);
      } finally {
        f.cleanup();
      }
    },
  );
}

for (const kind of ["directory", "file"] as const) {
  it(
    `refuses broad permissions on the authority ${kind} without repairing them`,
    {
      skip:
        process.platform === "win32"
          ? "POSIX mode bits do not establish Windows ACL ownership."
          : false,
    },
    () => {
      const f = storeFixture();
      try {
        f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
        const path = kind === "directory" ? f.directory : join(f.directory, "authority.sqlite");
        chmodSync(path, kind === "directory" ? 0o777 : 0o666);
        assert.throws(() => f.store.read(f.repository), /unavailable/);
        assert.throws(
          () =>
            f.store.update(f.repository, {
              type: "reject",
              expectedGeneration: 1,
              expectedPhase: "pending",
            }),
          /unavailable/,
        );
      } finally {
        f.cleanup();
      }
    },
  );
}
