import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  findGitNetworkCommands,
  gitUrlHost,
  isGitUrl,
  resolveGitTargets,
  type GitRunner,
} from "./git-remote-hosts.js";

const CWD = resolve("repo");

/** A fake git: remote URLs by name, an optional push URL map, and the current branch's remote. */
function fakeGit(
  remotes: Record<string, string>,
  opts: { push?: Record<string, string>; branch?: string; upstream?: string } = {},
): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "symbolic-ref") return opts.branch ?? null;
    if (a === "config") return opts.upstream ?? null;
    if (a === "remote" && b === undefined) return Object.keys(remotes).join("\n");
    if (a === "remote" && b === "get-url") {
      const name = args[args.length - 1];
      if (args.includes("--push") && opts.push?.[name]) return opts.push[name];
      return remotes[name] ?? null;
    }
    return null;
  };
  return { run, calls };
}

describe("gitUrlHost / isGitUrl", () => {
  it("parses https, ssh:// and scp-like forms", () => {
    assert.equal(gitUrlHost("https://github.com/org/repo.git"), "github.com");
    assert.equal(
      gitUrlHost("ssh://git@GitLab.example.com:2222/org/repo.git"),
      "gitlab.example.com",
    );
    assert.equal(gitUrlHost("git@github.com:org/repo.git"), "github.com");
    assert.equal(gitUrlHost("example.org:repo.git"), "example.org");
    assert.equal(gitUrlHost("git://code.example.net/repo"), "code.example.net");
  });

  it("gives no host for local paths and file URLs", () => {
    assert.equal(gitUrlHost("/srv/git/repo.git"), null);
    assert.equal(gitUrlHost("../repo"), null);
    assert.equal(gitUrlHost("C:\\repos\\x"), null);
    assert.equal(gitUrlHost("file:///srv/git/repo.git"), null);
  });

  it("tells a remote name from a URL", () => {
    assert.equal(isGitUrl("origin"), false);
    assert.equal(isGitUrl("git@github.com:org/repo.git"), true);
    assert.equal(isGitUrl("ssh://host/x"), true);
    assert.equal(isGitUrl("C:\\repo"), false);
  });
});

describe("findGitNetworkCommands", () => {
  it("finds push/fetch/pull/ls-remote/clone/remote update and skips local git", () => {
    const subs = (c: string) => findGitNetworkCommands(c, CWD).map((i) => i.sub);
    assert.deepEqual(subs("git status && git commit -m 'a b'"), []);
    assert.deepEqual(subs("git push -u origin main"), ["push"]);
    assert.deepEqual(subs("git fetch upstream; git pull"), ["fetch", "pull"]);
    assert.deepEqual(subs("git -C sub ls-remote origin"), ["ls-remote"]);
    assert.deepEqual(subs("git remote update"), ["remote-update"]);
    assert.deepEqual(subs("git remote add x y"), []);
  });

  it("does not read option values as the remote", () => {
    const [inv] = findGitNetworkCommands("git fetch --depth 1 upstream", CWD);
    assert.deepEqual(inv.positionals, ["upstream"]);
    const [push] = findGitNetworkCommands("git push -u origin main", CWD);
    assert.equal(push.positionals[0], "origin");
  });

  it("follows -C to the repository it names", () => {
    const [inv] = findGitNetworkCommands("git -C other push", CWD);
    assert.equal(inv.cwd, resolve(CWD, "other"));
  });
});

describe("resolveGitTargets", () => {
  it("resolves a named remote to its host", async () => {
    const { run } = fakeGit({
      origin: "https://github.com/o/r.git",
      up: "git@evil.example.com:o/r",
    });
    assert.deepEqual(await resolveGitTargets("git push origin main", CWD, run), {
      hosts: ["github.com"],
      unresolved: [],
    });
    assert.deepEqual((await resolveGitTargets("git fetch up", CWD, run)).hosts, [
      "evil.example.com",
    ]);
  });

  it("uses the push URL for push", async () => {
    const { run } = fakeGit(
      { origin: "https://github.com/o/r.git" },
      { push: { origin: "ssh://git@push.example.com/o/r.git" } },
    );
    assert.deepEqual((await resolveGitTargets("git push origin", CWD, run)).hosts, [
      "push.example.com",
    ]);
  });

  it("with no remote argument uses the upstream remote, else origin", async () => {
    const tracked = fakeGit(
      { origin: "https://github.com/o/r", fork: "https://fork.example.com/r" },
      { branch: "main", upstream: "fork" },
    );
    assert.deepEqual((await resolveGitTargets("git pull", CWD, tracked.run)).hosts, [
      "fork.example.com",
    ]);
    const untracked = fakeGit({ origin: "https://github.com/o/r" });
    assert.deepEqual((await resolveGitTargets("git pull", CWD, untracked.run)).hosts, [
      "github.com",
    ]);
  });

  it("takes the host of an explicit URL, without asking git", async () => {
    const { run, calls } = fakeGit({});
    const r = await resolveGitTargets("git clone git@evil.example.com:o/r.git dir", CWD, run);
    assert.deepEqual(r, { hosts: ["evil.example.com"], unresolved: [] });
    assert.deepEqual(calls, []);
  });

  it("reports a remote git cannot resolve", async () => {
    const { run } = fakeGit({ origin: "https://github.com/o/r" });
    assert.deepEqual(await resolveGitTargets("git push nosuch main", CWD, run), {
      hosts: [],
      unresolved: ["nosuch"],
    });
  });

  it("resolves every remote for --all and remote update", async () => {
    const { run } = fakeGit({ a: "https://a.example.com/r", b: "git@b.example.com:r" });
    const want = ["a.example.com", "b.example.com"];
    assert.deepEqual((await resolveGitTargets("git fetch --all", CWD, run)).hosts, want);
    assert.deepEqual((await resolveGitTargets("git remote update", CWD, run)).hosts, want);
  });

  it("skips local remotes", async () => {
    const { run } = fakeGit({ local: "/srv/git/r.git" });
    assert.deepEqual(await resolveGitTargets("git fetch local && git push .", CWD, run), {
      hosts: [],
      unresolved: [],
    });
  });
});
