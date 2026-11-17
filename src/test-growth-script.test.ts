import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "./post-pull-audit.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "test-growth.mjs");

interface Result {
  ok: boolean;
  net: number;
  limit: number;
  reasons: string[];
  message: string;
}
interface Lib {
  checkTestGrowth(o: { cwd: string; base?: string; limit?: number }): Result;
  netTestLines(numstat: string): number;
  growthReasons(messages: string): string[];
}

async function lib(): Promise<Lib> {
  return (await import(pathToFileURL(SCRIPT).href)) as Lib;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n") + "\n";

let repo: string;

function commit(message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
}

/** A fresh branch off `main` holding `files`, committed with `message`. */
function branch(name: string, message: string, files: Record<string, string>): void {
  git(repo, "checkout", "-q", "-b", name, "main");
  commit(message, files);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "kit-test-growth-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  commit("base", { "src/a.test.ts": lines(50), "src/a.ts": lines(10) });
});

after(() => rmTemp(repo));

describe("test-growth cap (fixture git repo)", () => {
  it("passes a change under the cap, counting only test files", async () => {
    const { checkTestGrowth } = await lib();
    branch("small", "small", { "src/b.test.ts": lines(300), "src/big.ts": lines(900) });
    const r = checkTestGrowth({ cwd: repo, base: "main" });
    assert.equal(r.ok, true);
    assert.equal(r.net, 300);
  });

  it("fails over the cap without a Test-Growth trailer", async () => {
    const { checkTestGrowth } = await lib();
    branch("big", "add tests", {
      "src/c.test.ts": lines(350),
      "src/d/e.test-support.ts": lines(100),
    });
    const r = checkTestGrowth({ cwd: repo, base: "main" });
    assert.equal(r.ok, false);
    assert.equal(r.net, 450);
    assert.match(r.message, /Test-Growth: <reason>/);
    const cli = spawnSync(process.execPath, [SCRIPT, "--base", "main"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(cli.status, 1);
  });

  it("passes over the cap when a commit states the reason, and prints it", async () => {
    const { checkTestGrowth } = await lib();
    branch("big-ok", "add tests\n\nTest-Growth: new parser needs a fixture per grammar rule", {
      "src/c.test.ts": lines(450),
    });
    const r = checkTestGrowth({ cwd: repo, base: "main" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, ["new parser needs a fixture per grammar rule"]);
    assert.match(r.message, /new parser needs a fixture/);
  });

  it("counts deleted test lines against added ones", async () => {
    const { netTestLines } = await lib();
    assert.equal(
      netTestLines(
        "500\t0\tsrc/x.test.ts\n0\t200\tsrc/y.test.ts\n-\t-\tsrc/z.test.ts\n9\t0\tsrc/x.ts",
      ),
      300,
    );
  });

  it("is a step of scripts/prepush.mjs and a CI job", () => {
    assert.match(readFileSync(join(root, "scripts", "prepush.mjs"), "utf8"), /"test-growth"/);
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(ci, /node scripts\/test-growth\.mjs/);
  });
});
