import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";

const protocolOptions = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];

export function gitMemoryCommand(args: string[], cwd: string): string {
  return execFileSync("git", [...protocolOptions, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A failed transport is not an empty branch. Pull needs all reachable history. */
export function cloneMemoryBranch(
  remote: string,
  branch: string,
  dir: string,
  history = false,
): boolean {
  const ref = "refs/heads/" + branch;
  const found = gitMemoryCommand(["ls-remote", "--heads", "--", remote, ref], dir).trim();
  if (found) {
    gitMemoryCommand(
      [
        "clone",
        ...(history ? [] : ["--depth", "1"]),
        "--single-branch",
        "--branch",
        branch,
        "--end-of-options",
        remote,
        ".",
      ],
      dir,
    );
  } else {
    gitMemoryCommand(["init", "-q"], dir);
    gitMemoryCommand(["remote", "add", "origin", remote], dir);
    gitMemoryCommand(["checkout", "-q", "-B", branch], dir);
  }
  return !!found;
}

function revision(dir: string, ref: string): string {
  const value = gitMemoryCommand(["rev-parse", "--verify", ref], dir).trim();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Git returned an invalid object ID for ${ref}`);
  }
  return value;
}

function firstParent(dir: string): string | null {
  try {
    return revision(dir, "HEAD^");
  } catch {
    return null;
  }
}

function fetchMemoryBranch(dir: string, branch: string): string {
  const ref = `refs/heads/${branch}`;
  gitMemoryCommand(["fetch", "-q", "origin", ref], dir);
  return revision(dir, "FETCH_HEAD");
}

function isAncestor(dir: string, ancestor: string, descendant: string): boolean {
  try {
    gitMemoryCommand(["merge-base", "--is-ancestor", ancestor, descendant], dir);
    return true;
  } catch {
    return false;
  }
}

/** Prove that `commit` is reachable from a fresh read of the remote branch. */
export function verifyMemoryPublication(dir: string, branch: string, commit: string): void {
  let remoteHead: string;
  try {
    remoteHead = fetchMemoryBranch(dir, branch);
  } catch (cause) {
    throw new Error(
      `Memory publication could not be verified: remote branch ${branch} is unavailable`,
      { cause },
    );
  }
  if (!isAncestor(dir, commit, remoteHead)) {
    throw new Error(
      `Memory publication could not be verified: the accepted commit is not reachable from remote branch ${branch}`,
    );
  }
}

/**
 * Publish HEAD without dropping a snapshot accepted by a concurrent writer.
 *
 * A retry joins the new remote tip with an `ours` merge: the current encrypted
 * blob stays at the tip while both parents remain reachable for history replay.
 */
export function publishMemoryBranch(dir: string, branch: string): void {
  let observedRemote = firstParent(dir);
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const commit = revision(dir, "HEAD");
    try {
      gitMemoryCommand(["push", "-q", "origin", `HEAD:${branch}`], dir);
    } catch (error) {
      lastFailure = error;
      let remoteHead: string;
      try {
        remoteHead = fetchMemoryBranch(dir, branch);
      } catch {
        throw error;
      }
      // The server may have accepted the commit before the client observed a
      // transport error. A fresh reachability proof is a valid receipt.
      if (isAncestor(dir, commit, remoteHead)) return;
      // No competing publication appeared. Retrying the same rejected update
      // would hide the real transport or server-hook failure.
      if (remoteHead === observedRemote) throw error;
      gitMemoryCommand(
        ["merge", "-q", "-s", "ours", "--no-edit", "--allow-unrelated-histories", remoteHead],
        dir,
      );
      observedRemote = remoteHead;
      continue;
    }
    verifyMemoryPublication(dir, branch, commit);
    return;
  }
  throw new Error("Memory publication did not converge after 8 concurrent remote updates", {
    cause: lastFailure,
  });
}

function blobAt(dir: string, revision: string, file: string): string | undefined {
  const entry = gitMemoryCommand(
    [
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      "--format=%(objectmode) %(objecttype) %(objectname)",
      revision,
      "--",
      file,
    ],
    dir,
  );
  if (!entry) return undefined;
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\0$/.exec(entry);
  if (!match)
    throw new Error("Memory snapshot must be a regular Git blob, not a link or directory");
  return match[2];
}

function* nulFields(path: string): Generator<string> {
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      pending += decoder.write(buffer.subarray(0, count));
      for (let end = pending.indexOf("\0"); end !== -1; end = pending.indexOf("\0")) {
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.end();
    if (pending) throw new Error("Git returned a truncated memory history record");
  } finally {
    closeSync(fd);
  }
}

function recordHistory(dir: string, file: string, logPath: string, index: DatabaseSync): void {
  const fd = openSync(logPath, "wx", 0o600);
  try {
    execFileSync(
      "git",
      [
        ...protocolOptions,
        "--literal-pathspecs",
        "log",
        "--format=x%H",
        "-m",
        "--root",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--reverse",
        "--topo-order",
        "HEAD",
        "--",
        file,
      ],
      { cwd: dir, stdio: ["ignore", fd, "pipe"] },
    );
  } finally {
    closeSync(fd);
  }

  index.exec(
    "CREATE TABLE snapshots (blob TEXT PRIMARY KEY, last_seen INTEGER NOT NULL); BEGIN IMMEDIATE",
  );
  const retain = index.prepare(
    `INSERT INTO snapshots (blob, last_seen) VALUES (?, ?)
     ON CONFLICT(blob) DO UPDATE SET last_seen=excluded.last_seen`,
  );
  let sequence = 0;
  try {
    for (const field of nulFields(logPath)) {
      if (!field.startsWith("\n:")) continue;
      const match = /^\n:[0-7]{6} ([0-7]{6}) [a-f0-9]+ ([a-f0-9]+) [A-Z][0-9]*$/.exec(field);
      if (!match) throw new Error("Git returned an invalid memory history record");
      const [, mode, blob] = match;
      if (mode === "000000") continue;
      if (mode !== "100644" && mode !== "100755") {
        throw new Error("Memory snapshot must be a regular Git blob, not a link or directory");
      }
      retain.run(blob, sequence++);
    }
    index.exec("COMMIT");
  } catch (error) {
    index.exec("ROLLBACK");
    throw error;
  }
}

/** Each yielded path lives until the next iteration; ciphertext never enters a JS buffer. */
function* materializeSnapshots(dir: string, blobs: Iterable<string>): Generator<string> {
  const path = join(dir, ".git", "kit-memory-snapshot");
  try {
    for (const blob of blobs) {
      const fd = openSync(path, "wx", 0o600);
      try {
        execFileSync("git", [...protocolOptions, "cat-file", "blob", blob], {
          cwd: dir,
          stdio: ["ignore", fd, "pipe"],
        });
      } finally {
        closeSync(fd);
      }
      yield path;
      rmSync(path);
    }
  } finally {
    rmSync(path, { force: true });
  }
}

function* indexedSnapshots(dir: string, file: string): Generator<string> {
  const temporary = mkdtempSync(join(tmpdir(), "kit-memory-history-"));
  const index = new DatabaseSync(join(temporary, "history.db"));
  try {
    recordHistory(dir, file, join(temporary, "history.log"), index);
    const rows = index.prepare("SELECT blob FROM snapshots ORDER BY last_seen").iterate();
    yield* materializeSnapshots(
      dir,
      (function* () {
        for (const row of rows) yield String(row.blob);
      })(),
    );
  } finally {
    index.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** A removed current file stays absent; a present one must retain all reachable versions. */
export function gitMemorySnapshots(dir: string, file: string): Iterable<string> | null {
  if (!blobAt(dir, "HEAD", file)) return null;
  return indexedSnapshots(dir, file);
}
