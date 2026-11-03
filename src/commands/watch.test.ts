import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function kit(cwd: string, home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A project directory and a separate HOME, so kit's own home files never land in the project. */
function sandbox(): { dir: string; home: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kit-watch-cmd-"));
  const home = mkdtempSync(join(tmpdir(), "kit-watch-home-"));
  return {
    dir,
    home,
    done: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("kit watch (CLI)", () => {
  it("prints usage and exits 1 for an unknown subcommand", () => {
    const s = sandbox();
    try {
      const r = kit(s.dir, s.home, "watch", "bogus");
      assert.equal(r.code, 1);
      assert.match(r.err, /usage: kit watch <run\|install\|status>/);
    } finally {
      s.done();
    }
  });

  it("status prints the cached ranked segment and stays silent without a cache", () => {
    const s = sandbox();
    try {
      assert.equal(kit(s.dir, s.home, "watch", "status").out.trim(), "");
      mkdirSync(join(s.dir, ".kit"));
      writeFileSync(
        join(s.dir, ".kit", "watch.json"),
        JSON.stringify({
          at: new Date().toISOString(),
          repo: "o/r",
          ranked: [
            {
              number: 3,
              title: "bump vite to 6.4.5",
              severity: "critical",
              ci: "failing",
              updatedAt: "x",
            },
          ],
        }),
      );
      assert.equal(
        kit(s.dir, s.home, "watch", "status").out.trim(),
        "sec-prs:1 critical #3 ci:failing",
      );
      assert.deepEqual(JSON.parse(kit(s.dir, s.home, "watch", "status", "--json").out), {
        line: "sec-prs:1 critical #3 ci:failing",
      });
    } finally {
      s.done();
    }
  });
});

describe("kit watch install (CLI)", () => {
  it("install --target cron prints a line and edits nothing", () => {
    const s = sandbox();
    try {
      const r = kit(
        s.dir,
        s.dir,
        "watch",
        "install",
        "--target",
        "cron",
        "--hour",
        "6",
        "--minute",
        "5",
      );
      assert.equal(r.code, 0);
      assert.match(r.out, /^5 6 \* \* \* cd '.*' && '.*' '.*' watch run >\/dev\/null 2>&1/m);
      assert.ok(!existsSync(join(s.dir, ".github")));
      assert.ok(!existsSync(join(s.home, "Library")));
    } finally {
      s.done();
    }
  });

  it("install --target launchd writes one plist under HOME and refuses to overwrite it", () => {
    const s = sandbox();
    try {
      const first = kit(s.dir, s.home, "watch", "install", "--target", "launchd");
      assert.equal(first.code, 0);
      const agents = join(s.home, "Library", "LaunchAgents");
      const files = readdirSync(agents);
      assert.equal(files.length, 1);
      assert.match(readFileSync(join(agents, files[0]), "utf8"), /<string>watch<\/string>/);
      const again = kit(s.dir, s.home, "watch", "install", "--target", "launchd");
      assert.equal(again.code, 1);
      assert.match(again.err, /exists/);
      assert.equal(
        kit(s.dir, s.home, "watch", "install", "--target", "launchd", "--force").code,
        0,
      );
    } finally {
      s.done();
    }
  });

  it("install --target workflow writes a read-only workflow in the project", () => {
    const s = sandbox();
    try {
      assert.equal(kit(s.dir, s.home, "watch", "install", "--target", "workflow").code, 0);
      const wf = join(s.dir, ".github", "workflows", "kit-watch.yml");
      assert.ok(existsSync(wf));
      assert.match(readFileSync(wf, "utf8"), /pull-requests: read/);
    } finally {
      s.done();
    }
  });

  it("install rejects an hour or target out of range and writes nothing", () => {
    const s = sandbox();
    try {
      assert.equal(
        kit(s.dir, s.home, "watch", "install", "--target", "cron", "--hour", "24").code,
        1,
      );
      assert.equal(kit(s.dir, s.home, "watch", "install", "--target", "nope").code, 1);
      assert.ok(!existsSync(join(s.dir, ".github")));
      assert.ok(!existsSync(join(s.home, "Library")));
    } finally {
      s.done();
    }
  });
});
