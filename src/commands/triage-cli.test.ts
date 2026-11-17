/**
 * `kit triage` entry point: the help block, the type check, the target check and the flag handling
 * that run before any package is evaluated. Nothing here reaches a registry. They pin the words
 * and the exit value so cmdTriage can be split without changing either.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cmdTriage } from "./triage.js";

const savedArgv = process.argv;
afterEach(() => {
  process.argv = savedArgv;
});

async function triage(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  process.argv = [process.execPath, "kit", "triage", ...args];
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const ok = await cmdTriage();
    const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    return { ok, out: plain(out), err: plain(err) };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("kit triage help", () => {
  for (const args of [[], ["--help"], ["-h"], ["--sandbox"], ["--deep"]]) {
    it(`prints the usage and succeeds for: kit triage ${args.join(" ")}`, async () => {
      const r = await triage(...args);
      assert.equal(r.ok, true);
      assert.match(r.out, /kit triage — Security evaluation before installing packages/);
      assert.match(r.out, /Usage:/);
      assert.match(r.out, /Examples:/);
      assert.match(r.out, /kit triage npm express/);
    });
  }

  it("lists every kind of target the command accepts", async () => {
    const { out } = await triage("--help");
    for (const row of [
      "kit triage docker <image>",
      "kit triage npm <package>",
      "kit triage npm <package> --sandbox",
      "kit triage pip <package>",
      "kit triage gem <name>[@version]",
      "kit triage brew <formula>",
      "kit triage repo <github-url>",
      "kit triage model <path>",
      "kit triage model <path> --scan-bytes",
      "kit triage skill <path|name>",
      "kit triage skill <path|name> --deep",
      "kit triage mcp <server> --tools <f>",
      "kit triage plugin [name]",
      "kit triage vault-config",
      "kit triage all <target>",
      "kit triage tools",
      "kit triage check-deps",
      "kit triage check-skills",
      "kit triage instructions [path]",
      "kit triage pkg <file.pkg>",
    ]) {
      assert.ok(out.includes(row), `help lacks: ${row}`);
    }
  });
});

describe("kit triage checks before it evaluates anything", () => {
  it("refuses an unknown type, names the valid ones and fails", async () => {
    const r = await triage("bogus");
    assert.equal(r.ok, false);
    assert.match(r.err, /Unknown triage type: bogus/);
    assert.match(r.err, /Valid types: npm, pip, gem, brew, docker, repo, skill, mcp, model/);
    assert.match(r.err, /check-deps, check-skills/);
  });

  for (const type of ["npm", "pip", "docker", "brew", "repo", "skill", "all"]) {
    it(`needs a target for ${type}`, async () => {
      const r = await triage(type);
      assert.equal(r.ok, false);
      assert.match(r.err, new RegExp(`Target required for triage ${type}`));
      assert.doesNotMatch(r.out, /Running triage on/);
    });
  }

  it("does not read a flag as the target", async () => {
    const r = await triage("npm", "--sandbox");
    assert.equal(r.ok, false);
    assert.match(r.err, /Target required for triage npm/);
  });

  it("lists the installed security tools and succeeds", async () => {
    const r = await triage("tools");
    assert.equal(r.ok, true);
    assert.ok(r.out.length > 0);
  });
});
