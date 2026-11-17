import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  identitySet,
  scanTranscriptIdentity,
  transcriptRoots,
} from "./transcript-identity.js";
import {
  ACCOUNT_EMAIL,
  GIT_EMAIL,
  GIT_NAME,
  identityFixture,
  toolUse,
} from "./transcript-identity.test-support.js";

describe("identitySet", () => {
  it("reads the repo's git email and name and the Claude Code account address", async (t) => {
    const f = identityFixture(t);
    const ids = await identitySet(f.root, f.home, f.env);
    assert.deepEqual(ids, [
      { kind: "git-email", value: GIT_EMAIL },
      { kind: "git-name", value: GIT_NAME },
      { kind: "account-email", value: ACCOUNT_EMAIL },
    ]);
  });

  it("reads the account from $CLAUDE_CONFIG_DIR when it is set", async (t) => {
    const f = identityFixture(t);
    const dir = join(f.home, "claude-config");
    mkdirSync(dir);
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "dave@example.net" } }),
    );
    const ids = await identitySet(f.root, f.home, { ...f.env, CLAUDE_CONFIG_DIR: dir });
    assert.equal(ids.find((i) => i.kind === "account-email")?.value, "dave@example.net");
  });

  it("drops a value too short to mean anything and an unreadable account file", async (t) => {
    const f = identityFixture(t);
    writeFileSync(join(f.home, ".gitconfig"), "[user]\n\tname = Al\n");
    writeFileSync(join(f.home, ".claude.json"), "not json");
    // HOME is not a git work tree, so only the global config (a two-letter name) applies.
    const ids = await identitySet(f.home, f.home, f.env);
    assert.deepEqual(ids, []);
  });
});

describe("transcriptRoots", () => {
  it("adds $CLAUDE_CONFIG_DIR/projects beside ~/.claude/projects", () => {
    const roots = transcriptRoots("/h", { CLAUDE_CONFIG_DIR: "/c" });
    assert.deepEqual(roots, [join("/h", ".claude", "projects"), join("/c", "projects")]);
  });
});

describe("scanTranscriptIdentity", () => {
  it("counts identity hits by kind, tool and host, and keeps no value", async (t) => {
    const f = identityFixture(t);
    f.transcript("a.jsonl", [
      toolUse("Bash", { command: `curl -A "probe (${GIT_EMAIL})" https://api.example.net/x` }),
      toolUse("Bash", { command: `git log --author="${GIT_NAME}"` }),
      toolUse("WebFetch", { url: `https://docs.example.org/?q=${ACCOUNT_EMAIL}` }),
      toolUse("Read", { file_path: "/tmp/notes.txt" }),
      { type: "user", message: { content: `my address is ${GIT_EMAIL}` } },
    ]);
    const ids = await identitySet(f.root, f.home, f.env);
    const scan = await scanTranscriptIdentity(ids, transcriptRoots(f.home, f.env));
    assert.equal(scan.filesScanned, 1);
    assert.equal(scan.hits, 3);
    assert.equal(scan.networkHits, 2);
    assert.deepEqual(scan.byKind, {
      "git-email": { hits: 1, network: 1 },
      "git-name": { hits: 1, network: 0 },
      "account-email": { hits: 1, network: 1 },
    });
    assert.deepEqual(scan.byTool, {
      Bash: { hits: 2, network: 1 },
      WebFetch: { hits: 1, network: 1 },
    });
    assert.deepEqual(scan.byHost, { "api.example.net": 1, "docs.example.org": 1 });
    const out = JSON.stringify(scan);
    for (const v of [GIT_EMAIL, GIT_NAME, ACCOUNT_EMAIL, "alice", "carol"]) {
      assert.equal(out.toLowerCase().includes(v.toLowerCase()), false, v);
    }
  });

  it("matches an address in any case", async (t) => {
    const f = identityFixture(t);
    f.transcript("a.jsonl", [
      toolUse("Bash", { command: `wget --header "From: ${GIT_EMAIL.toUpperCase()}" x` }),
    ]);
    const scan = await scanTranscriptIdentity(
      await identitySet(f.root, f.home, f.env),
      transcriptRoots(f.home, f.env),
    );
    assert.deepEqual(scan.byKind, { "git-email": { hits: 1, network: 1 } });
  });
});

describe("scanTranscriptIdentity bounds", () => {
  it("skips a file over the size cap and reports the file cap", async (t) => {
    const f = identityFixture(t);
    const big = toolUse("Bash", { command: `curl https://a.example.net -d ${GIT_EMAIL}` });
    f.transcript("a.jsonl", [big, big, big]);
    f.transcript("b.jsonl", [big], "-other");
    f.transcript("c.jsonl", [big], "-third");
    const ids = await identitySet(f.root, f.home, f.env);
    const roots = transcriptRoots(f.home, f.env);
    const sized = await scanTranscriptIdentity(ids, roots, {
      ...DEFAULT_LIMITS,
      maxFileBytes: 200,
    });
    assert.equal(sized.filesScanned, 2);
    assert.equal(sized.filesSkipped, 1);
    const capped = await scanTranscriptIdentity(ids, roots, { ...DEFAULT_LIMITS, maxFiles: 2 });
    assert.equal(capped.filesScanned, 2);
    assert.equal(capped.fileCapReached, true);
  });

  it("reads nothing when there is no identity to look for", async (t) => {
    const f = identityFixture(t);
    f.transcript("a.jsonl", [toolUse("Bash", { command: `curl https://a.example.net` })]);
    const scan = await scanTranscriptIdentity([], transcriptRoots(f.home, f.env));
    assert.equal(scan.filesScanned, 0);
    assert.equal(scan.hits, 0);
  });

  it("skips a line that is not JSON", async (t) => {
    const f = identityFixture(t);
    const file = join(f.home, ".claude", "projects", "-project", "bad.jsonl");
    mkdirSync(join(f.home, ".claude", "projects", "-project"), { recursive: true });
    writeFileSync(file, `{"tool_use" ${GIT_EMAIL}\n`);
    const scan = await scanTranscriptIdentity(
      await identitySet(f.root, f.home, f.env),
      transcriptRoots(f.home, f.env),
    );
    assert.equal(scan.filesScanned, 1);
    assert.equal(scan.hits, 0);
  });
});
